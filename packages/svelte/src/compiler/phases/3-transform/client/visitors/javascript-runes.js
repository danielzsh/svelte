import { get_rune } from '../../../scope.js';
import { is_hoistable_function, transform_inspect_rune } from '../../utils.js';
import * as b from '../../../../utils/builders.js';
import * as assert from '../../../../utils/assert.js';
import {
	get_prop_source,
	has_derived_properties,
	is_derived_object_property,
	is_state_source,
	should_proxy_or_freeze
} from '../utils.js';
import { extract_paths, unwrap_ts_expression } from '../../../../utils/ast.js';

/** @type {import('../types.js').ComponentVisitors} */
export const javascript_visitors_runes = {
	ClassBody(node, { state, visit }) {
		/** @type {Map<string, import('../types.js').StateField>} */
		const public_state = new Map();

		/** @type {Map<string, import('../types.js').StateField>} */
		const private_state = new Map();

		/** @type {string[]} */
		const private_ids = [];

		for (const definition of node.body) {
			if (
				definition.type === 'PropertyDefinition' &&
				(definition.key.type === 'Identifier' || definition.key.type === 'PrivateIdentifier')
			) {
				const { type, name } = definition.key;

				const is_private = type === 'PrivateIdentifier';
				if (is_private) private_ids.push(name);

				if (definition.value?.type === 'CallExpression') {
					const rune = get_rune(definition.value, state.scope);
					if (rune === '$state' || rune === '$state.frozen' || rune === '$derived') {
						/** @type {import('../types.js').StateField} */
						const field = {
							kind:
								rune === '$state' ? 'state' : rune === '$state.frozen' ? 'frozen_state' : 'derived',
							// @ts-expect-error this is set in the next pass
							id: is_private ? definition.key : null
						};

						if (is_private) {
							private_state.set(name, field);
						} else {
							public_state.set(name, field);
						}
					}
				}
			}
		}

		// each `foo = $state()` needs a backing `#foo` field
		for (const [name, field] of public_state) {
			let deconflicted = name;
			while (private_ids.includes(deconflicted)) {
				deconflicted = '_' + deconflicted;
			}

			private_ids.push(deconflicted);
			field.id = b.private_id(deconflicted);
		}

		/** @type {Array<import('estree').MethodDefinition | import('estree').PropertyDefinition>} */
		const body = [];

		const child_state = { ...state, public_state, private_state };

		// Replace parts of the class body
		for (const definition of node.body) {
			if (
				definition.type === 'PropertyDefinition' &&
				(definition.key.type === 'Identifier' || definition.key.type === 'PrivateIdentifier')
			) {
				const name = definition.key.name;

				const is_private = definition.key.type === 'PrivateIdentifier';
				const field = (is_private ? private_state : public_state).get(name);

				if (definition.value?.type === 'CallExpression' && field !== undefined) {
					let value = null;

					if (definition.value.arguments.length > 0) {
						const init = /** @type {import('estree').Expression} **/ (
							visit(definition.value.arguments[0], child_state)
						);

						value =
							field.kind === 'state'
								? b.call(
										'$.source',
										should_proxy_or_freeze(init, state.scope) ? b.call('$.proxy', init) : init
									)
								: field.kind === 'frozen_state'
									? b.call(
											'$.source',
											should_proxy_or_freeze(init, state.scope) ? b.call('$.freeze', init) : init
										)
									: b.call('$.derived', b.thunk(init));
					} else {
						// if no arguments, we know it's state as `$derived()` is a compile error
						value = b.call('$.source');
					}

					if (is_private) {
						body.push(b.prop_def(field.id, value));
					} else {
						// #foo;
						const member = b.member(b.this, field.id);
						body.push(b.prop_def(field.id, value));

						// get foo() { return this.#foo; }
						body.push(b.method('get', definition.key, [], [b.return(b.call('$.get', member))]));

						if (field.kind === 'state') {
							// set foo(value) { this.#foo = value; }
							const value = b.id('value');
							body.push(
								b.method(
									'set',
									definition.key,
									[value],
									[b.stmt(b.call('$.set', member, b.call('$.proxy', value)))]
								)
							);
						}

						if (field.kind === 'frozen_state') {
							// set foo(value) { this.#foo = value; }
							const value = b.id('value');
							body.push(
								b.method(
									'set',
									definition.key,
									[value],
									[b.stmt(b.call('$.set', member, b.call('$.freeze', value)))]
								)
							);
						}

						if (field.kind === 'derived' && state.options.dev) {
							body.push(
								b.method(
									'set',
									definition.key,
									[b.id('_')],
									[b.throw_error(`Cannot update a derived property ('${name}')`)]
								)
							);
						}
					}

					continue;
				}
			}

			body.push(/** @type {import('estree').MethodDefinition} **/ (visit(definition, child_state)));
		}

		return { ...node, body };
	},
	VariableDeclaration(node, { state, visit }) {
		const declarations = [];

		for (const declarator of node.declarations) {
			const init = unwrap_ts_expression(declarator.init);
			const rune = get_rune(init, state.scope);
			if (!rune || rune === '$effect.active' || rune === '$effect.root' || rune === '$inspect') {
				if (init != null && is_hoistable_function(init)) {
					const hoistable_function = visit(init);
					state.hoisted.push(
						b.declaration(
							'const',
							declarator.id,
							/** @type {import('estree').Expression} */ (hoistable_function)
						)
					);
					continue;
				}
				declarations.push(/** @type {import('estree').VariableDeclarator} */ (visit(declarator)));
				continue;
			}

			if (rune === '$props') {
				assert.equal(declarator.id.type, 'ObjectPattern');

				/** @type {string[]} */
				const seen = [];

				for (const property of declarator.id.properties) {
					if (property.type === 'Property') {
						const key = /** @type {import('estree').Identifier | import('estree').Literal} */ (
							property.key
						);
						const name = key.type === 'Identifier' ? key.name : /** @type {string} */ (key.value);

						seen.push(name);

						let id = property.value;
						let initial = undefined;

						if (property.value.type === 'AssignmentPattern') {
							id = property.value.left;
							initial = /** @type {import('estree').Expression} */ (visit(property.value.right));
						}

						assert.equal(id.type, 'Identifier');

						const binding = /** @type {import('#compiler').Binding} */ (state.scope.get(id.name));

						if (binding.reassigned || state.analysis.accessors || initial) {
							declarations.push(b.declarator(id, get_prop_source(binding, state, name, initial)));
						}
					} else {
						// RestElement
						declarations.push(
							b.declarator(
								property.argument,
								b.call(
									'$.rest_props',
									b.id('$$props'),
									b.array(seen.map((name) => b.literal(name)))
								)
							)
						);
					}
				}

				// TODO
				continue;
			}

			const args = /** @type {import('estree').CallExpression} */ (init).arguments;
			const value =
				args.length === 0
					? b.id('undefined')
					: /** @type {import('estree').Expression} */ (visit(args[0]));

			if (rune === '$state' || rune === '$state.frozen') {
				/**
				 * @param {import('estree').Identifier} id
				 * @param {import('estree').Expression} value
				 */
				const create_state_declarator = (id, value) => {
					const binding = /** @type {import('#compiler').Binding} */ (state.scope.get(id.name));
					if (should_proxy_or_freeze(value, state.scope)) {
						value = b.call(rune === '$state' ? '$.proxy' : '$.freeze', value);
					}
					if (is_state_source(binding, state)) {
						value = b.call('$.source', value);
					}
					return value;
				};

				if (declarator.id.type === 'Identifier') {
					declarations.push(
						b.declarator(declarator.id, create_state_declarator(declarator.id, value))
					);
				} else {
					const tmp = state.scope.generate('tmp');
					const paths = extract_paths(declarator.id);
					declarations.push(
						b.declarator(b.id(tmp), value),
						...paths.map((path) => {
							const value = path.expression?.(b.id(tmp));
							const binding = state.scope.get(
								/** @type {import('estree').Identifier} */ (path.node).name
							);
							return b.declarator(
								path.node,
								binding?.kind === 'state' || binding?.kind === 'frozen_state'
									? create_state_declarator(binding.node, value)
									: value
							);
						})
					);
				}
				continue;
			}

			if (rune === '$derived') {
				if (declarator.id.type === 'Identifier') {
					declarations.push(b.declarator(declarator.id, b.call('$.derived', b.thunk(value))));
				} else {
					const bindings = state.scope.get_bindings(declarator);
					const id = state.scope.generate('derived_value');
					const body = [];
					const decorator_id = declarator.id;

					if (decorator_id.type === 'ObjectPattern' && decorator_id.metadata != null) {
						const identifiers = decorator_id.metadata.identifiers;
						body.push(
							b.var('$object', value),
							b.return(
								b.array(
									bindings.map((binding) => {
										const binding_body = [];
										const node = binding.node;
										const properties = identifiers.get(node.name) || decorator_id.properties;
										const matching = decorator_id.properties.filter(
											(p) => properties === undefined || properties.includes(p)
										);
										const matching_rest = matching.find((p) => p.type === 'RestElement');
										if (matching.length - (matching_rest ? 1 : 0) > 0) {
											binding_body.push(
												b.var(
													{
														...decorator_id,
														properties: matching
													},
													b.id('$object')
												),
												b.return(node)
											);
										}
										if (matching_rest) {
											const not_matching = /** @type {import('estree').Property[]} */ (
												decorator_id.properties.filter((p) => !matching.includes(p))
											);
											binding_body.push(
												b.return(
													b.call(
														'$.rest_object',
														b.id('$object'),
														b.array(
															not_matching.map((p) =>
																p.key.type === 'Identifier' || p.key.type === 'PrivateIdentifier'
																	? b.literal(p.key.name)
																	: p.key
															)
														)
													)
												)
											);
										}
										return b.thunk(b.block(binding_body));
									})
								)
							)
						);
						for (let i = 0; i < bindings.length; i++) {
							bindings[i].expression = b.call(
								b.member(b.call('$.get', b.id(id)), b.literal(i), true)
							);
						}
					} else {
						body.push(
							b.var(decorator_id, value),
							b.return(b.array(bindings.map((binding) => binding.node)))
						);
						for (let i = 0; i < bindings.length; i++) {
							bindings[i].expression = b.member(b.call('$.get', b.id(id)), b.literal(i), true);
						}
					}
					declarations.push(b.declarator(b.id(id), b.call('$.derived', b.thunk(b.block(body)))));
				}
				continue;
			}
		}

		if (declarations.length === 0) {
			return b.empty;
		}

		return {
			...node,
			declarations
		};
	},
	ExpressionStatement(node, context) {
		if (node.expression.type === 'CallExpression') {
			const callee = node.expression.callee;

			if (
				callee.type === 'Identifier' &&
				callee.name === '$effect' &&
				!context.state.scope.get('$effect')
			) {
				const func = context.visit(node.expression.arguments[0]);
				return {
					...node,
					expression: b.call('$.user_effect', /** @type {import('estree').Expression} */ (func))
				};
			}

			if (
				callee.type === 'MemberExpression' &&
				callee.object.type === 'Identifier' &&
				callee.object.name === '$effect' &&
				callee.property.type === 'Identifier' &&
				callee.property.name === 'pre' &&
				!context.state.scope.get('$effect')
			) {
				const func = context.visit(node.expression.arguments[0]);
				return {
					...node,
					expression: b.call('$.pre_effect', /** @type {import('estree').Expression} */ (func))
				};
			}
		}

		context.next();
	},
	CallExpression(node, context) {
		const rune = get_rune(node, context.state.scope);

		if (rune === '$effect.active') {
			return b.call('$.effect_active');
		}

		if (rune === '$effect.root') {
			const args = /** @type {import('estree').Expression[]} */ (
				node.arguments.map((arg) => context.visit(arg))
			);
			return b.call('$.user_root_effect', ...args);
		}

		if (rune === '$inspect' || rune === '$inspect().with') {
			return transform_inspect_rune(node, context);
		}

		context.next();
	},
	ObjectExpression(node, context) {
		const scope = context.state.scope;

		if (has_derived_properties(node, scope)) {
			/** @type {string[]} **/
			const to_reference = [];
			/** @type {Array<import('estree').Property | import('estree').SpreadElement>} **/
			const properties = [];
			const deriveds = [];

			const might_be_in_derived_scope = context.path.some((p) => {
				if (
					p.type === 'VariableDeclaration' &&
					p.declarations.length === 1 &&
					p.declarations[0].init?.type === 'CallExpression' &&
					get_rune(p.declarations[0].init, scope) === '$derived'
				) {
					return true;
				}
				if (
					p.type === 'FunctionDeclaration' ||
					p.type === 'ArrowFunctionExpression' ||
					p.type === 'FunctionExpression'
				) {
					return true;
				}
				return false;
			});

			for (const property of node.properties) {
				if (property.type === 'Property' && is_derived_object_property(property, scope)) {
					const value = /** @type {import('estree').CallExpression} **/ (property.value)
						.arguments[0];
					let needs_wrapping_in_derived = true;
					let derived_name = '';

					if (value.type === 'Identifier') {
						derived_name = value.name;
						const binding = scope.get(derived_name);
						if (binding !== null && (binding.kind === 'state' || binding.kind === 'derived')) {
							needs_wrapping_in_derived = false;
						}
					}

					if (needs_wrapping_in_derived) {
						derived_name = scope.generate('derived_property');
						const derived_expression = /** @type {import('estree').Expression} **/ (
							context.visit(value)
						);
						deriveds.push(b.var(derived_name, b.call('$.derived', b.thunk(derived_expression))));
					}

					if (!to_reference.includes(derived_name)) {
						to_reference.push(derived_name);
					}

					properties.push({
						...property,
						kind: 'get',
						value: b.function(
							null,
							[],
							b.block([
								b.return(
									might_be_in_derived_scope
										? b.call('$.get_derived', b.id('$consumer'), b.id(derived_name))
										: b.call('$.get', b.id(derived_name))
								)
							])
						)
					});
				} else {
					properties.push(
						/** @type {import('estree').Property | import('estree').SpreadElement} **/ (
							context.visit(property)
						)
					);
				}
			}

			const body = [];
			if (deriveds.length > 0) {
				body.push(...deriveds);
			}
			if (might_be_in_derived_scope) {
				body.push(b.var('$consumer', b.id('$.current_consumer')));
				if (to_reference.length > 0) {
					body.push(b.stmt(b.sequence(to_reference.map((r) => b.call('$.get', b.id(r))))));
				}
			}
			body.push(b.return(b.object(properties)));
			return b.call(b.thunk(b.block(body)));
		}

		context.next();
	}
};
