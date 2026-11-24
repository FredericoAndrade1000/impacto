import ts from 'typescript';

export interface Phrases { keys: Set<string>; unknown: boolean }
const AUTHORED_MESSAGE = Symbol('authored message');
type Path = readonly (string | typeof AUTHORED_MESSAGE)[];
interface Binding { node: ts.Node; path: Path; environment: Environment }
type Environment = ReadonlyMap<ts.Symbol, Binding>;
const empty = (): Phrases => ({ keys: new Set(), unknown: false });
const unknown = (): Phrases => ({ keys: new Set(), unknown: true });
const join = (parts: readonly Phrases[]): Phrases => ({ keys: new Set(parts.flatMap(part => [...part.keys])), unknown: parts.some(part => part.unknown) });
const nameOf = (name: ts.Node): string | undefined => ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : undefined;

// Resolve only immutable source phrases: literals, catalogue projections, aliases,
// and collection callbacks. This is not a JavaScript evaluator: mutation, arbitrary
// methods, runtime strings and player data stay unknown and fail the authoring gate.
export class SourcePhrases {
  private readonly checker: ts.TypeChecker;
  private readonly mutated = new Set<ts.Symbol>();
  constructor(checker: ts.TypeChecker, files: readonly ts.SourceFile[] = []) {
    this.checker = checker;
    const scalar = (type: ts.Type): boolean => type.isUnion() ? type.types.every(scalar) : Boolean(type.flags &
      (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Never));
    const mark = (node: ts.Node, depth = 0): void => {
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) { mark(node.expression, depth + 1); return; }
      if (ts.isParenthesizedExpression(node)) { mark(node.expression, depth); return; }
      if (ts.isCallExpression(node)) {
        // Reordering/replacing a copied collection does not mutate its source.
        // A write into a referenced entry still invalidates the input.
        if (depth < 2 && ts.isPropertyAccessExpression(node.expression) && ['map', 'flatMap', 'filter', 'slice', 'toSorted', 'toReversed', 'entries', 'keys', 'values', 'fromEntries', 'from'].includes(node.expression.name.text)) return;
        // A returned object may alias the input. Without modelling effects,
        // writes through it make its inputs ineligible as immutable sources.
        node.arguments.forEach(argument => { if (!scalar(checker.getTypeAtLocation(argument))) mark(argument, depth); });
        if (ts.isPropertyAccessExpression(node.expression)) mark(node.expression.expression, depth);
        return;
      }
      if (!ts.isIdentifier(node)) return;
      const symbol = this.symbol(node); if (!symbol || this.mutated.has(symbol)) return;
      this.mutated.add(symbol);
      const declaration = symbol.valueDeclaration;
      // Aliases of a catalogue share its contents. Refuse writes rather than
      // attempting to model the value before/after a mutation.
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) mark(declaration.initializer, depth);
    };
    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) mark(node.left);
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) mark(node.operand);
      if (ts.isDeleteExpression(node)) mark(node.expression);
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        if (['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin', 'set', 'delete', 'clear'].includes(node.expression.name.text)) mark(node.expression.expression);
        if (node.expression.expression.getText() === 'Object' && ['assign', 'defineProperty', 'defineProperties'].includes(node.expression.name.text) && node.arguments[0]) mark(node.arguments[0]);
      }
      ts.forEachChild(node, visit);
    };
    files.forEach(file => visit(file));
  }
  private symbol(node: ts.Node): ts.Symbol | undefined {
    const symbol = ts.isShorthandPropertyAssignment(node.parent) ? this.checker.getShorthandAssignmentValueSymbol(node.parent) : this.checker.getSymbolAtLocation(node);
    return symbol && symbol.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol;
  }
  declaration(node: ts.Node): ts.Declaration | undefined { return this.symbol(node)?.valueDeclaration; }
  factory(node: ts.Node, seen: readonly ts.Node[] = []): string | undefined {
    if (seen.includes(node)) return undefined;
    const declaration = this.declaration(node); if (!declaration) return undefined;
    if (/\/src\/(?:i18n|user-message)\.ts$/.test(declaration.getSourceFile().fileName.replaceAll('\\', '/')) && ts.isFunctionDeclaration(declaration)) return declaration.name?.text;
    return ts.isVariableDeclaration(declaration) && declaration.initializer ? this.factory(declaration.initializer, [...seen, node]) : undefined;
  }
  authored(node: ts.Node): Phrases { return this.resolve(node, [AUTHORED_MESSAGE]); }
  resolve(node: ts.Node, path: Path = [], environment: Environment = new Map(), parents: readonly ts.Node[] = []): Phrases {
    if (parents.length > 80 || parents.includes(node)) return unknown();
    const visited = [...parents, node], read = (next: ts.Node, rest = path, env = environment) => this.resolve(next, rest, env, visited);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) return read(node.expression);
    if (path[0] === AUTHORED_MESSAGE && ts.isTaggedTemplateExpression(node) && this.factory(node.tag) === 'phrase') {
      const template = node.template;
      return { keys: new Set([ts.isNoSubstitutionTemplateLiteral(template) ? template.text : template.head.text + template.templateSpans.map((span, i) => `{${i}}${span.literal.text}`).join('')]), unknown: false };
    }
    if (ts.isStringLiteralLike(node)) return path.length ? unknown() : { keys: new Set([node.text]), unknown: false };
    if (node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.UndefinedKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.TrueKeyword) return empty();
    if (ts.isPropertyAccessExpression(node)) return read(node.expression, [node.name.text, ...path]);
    if (ts.isElementAccessExpression(node)) {
      const index = node.argumentExpression;
      return read(node.expression, [index && (ts.isStringLiteralLike(index) || ts.isNumericLiteral(index)) ? index.text : '*', ...path]);
    }
    if (ts.isConditionalExpression(node)) return join([read(node.whenTrue), read(node.whenFalse)]);
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return read(node.right);
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) return join([read(node.left), read(node.right)]);
      if (op === ts.SyntaxKind.PlusToken && !path.length) {
        const a = read(node.left), b = read(node.right);
        return { keys: new Set([...a.keys].flatMap(first => [...b.keys].map(second => first + second))), unknown: a.unknown || b.unknown };
      }
      return unknown();
    }
    if (ts.isObjectLiteralExpression(node)) {
      const [field, ...rest] = path;
      if (!field || typeof field !== 'string') return unknown();
      const values: Phrases[] = [];
      for (const property of [...node.properties].reverse()) {
        if (ts.isSpreadAssignment(property)) values.push(read(property.expression));
        else if (field === '*' || nameOf(property.name) === field) {
          values.push(ts.isPropertyAssignment(property) ? read(property.initializer, rest) : ts.isShorthandPropertyAssignment(property) ? read(property.name, rest) : unknown());
          // Earlier spreads cannot replace a later explicit field. Later
          // spreads have already been checked and may override it.
          if (field !== '*') break;
        }
      }
      return join(values);
    }
    if (ts.isArrayLiteralExpression(node)) {
      const [index, ...rest] = path;
      if (!index || typeof index !== 'string') return unknown();
      const elements = index === '*' ? node.elements : [node.elements[Number(index)]].filter((element): element is ts.Expression => Boolean(element));
      return join(elements.map(element => ts.isSpreadElement(element) ? read(element.expression, ['*', ...rest]) : ts.isOmittedExpression(element) ? empty() : read(element, rest)));
    }
    if (ts.isIdentifier(node)) {
      if (node.text === 'undefined') return empty();
      const symbol = this.symbol(node), bound = symbol && environment.get(symbol);
      if (symbol && this.mutated.has(symbol)) return unknown();
      if (bound) return read(bound.node, [...bound.path, ...path], bound.environment);
      const declaration = symbol?.valueDeclaration;
      if (!declaration) return unknown();
      if (ts.isVariableDeclaration(declaration)) {
        if (declaration.initializer) return ts.isVariableDeclarationList(declaration.parent) && declaration.parent.flags & ts.NodeFlags.Const ? read(declaration.initializer) : unknown();
        const loop = declaration.parent.parent;
        if (ts.isForOfStatement(loop)) return read(loop.expression, ['*', ...path]);
      }
      if (ts.isBindingElement(declaration)) {
        const parent = declaration.parent, owner = parent.parent,
          key = ts.isArrayBindingPattern(parent) ? String(parent.elements.indexOf(declaration)) : nameOf(declaration.propertyName ?? declaration.name);
        if (!key) return unknown();
        if (ts.isVariableDeclaration(owner)) {
          if (owner.initializer) return read(owner.initializer, [key, ...path]);
          const loop = owner.parent.parent;
          if (ts.isForOfStatement(loop)) return read(loop.expression, ['*', key, ...path]);
        }
        if (ts.isParameter(owner)) return this.parameter(owner, [key, ...path], environment, visited);
      }
      if (ts.isParameter(declaration)) return this.parameter(declaration, path, environment, visited);
      return unknown();
    }
    if (ts.isCallExpression(node)) {
      const callable = node.expression, args = node.arguments;
      if (path[0] === AUTHORED_MESSAGE && this.factory(callable) === 'phrase') return args[0] ? read(args[0], []) : unknown();
      if (ts.isPropertyAccessExpression(callable)) {
        const method = callable.name.text, receiver = callable.expression;
        if (ts.isIdentifier(receiver) && receiver.text === 'Object') {
          const input = args[0]; if (!input) return unknown();
          if (method === 'freeze') return read(input);
          if (method === 'values') return path[0] === '*' ? read(input, ['*', ...path.slice(1)]) : unknown();
          if (method === 'entries' && path[0] === '*') return path[1] === '1' ? read(input, ['*', ...path.slice(2)]) : unknown();
        }
        if (method === 'filter' || method === 'slice' || method === 'toSorted') return read(receiver);
        if (method === 'find' || method === 'at') return read(receiver, ['*', ...path]);
        if ((method === 'map' || method === 'flatMap') && path[0] === '*') {
          const callback = args[0];
          if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
            return this.returns(callback, path.slice(1), this.bind(callback, [{ node: receiver, path: ['*'], environment }], environment), visited);
          }
        }
        if (method === 'get' && ts.isIdentifier(receiver)) {
          const declaration = this.declaration(receiver);
          if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isNewExpression(declaration.initializer) && declaration.initializer.expression.getText() === 'Map') {
            const input = declaration.initializer.arguments?.[0]; if (input) return read(input, ['*', '1', ...path]);
          }
        }
      }
      const declaration = this.declaration(callable);
      const fn = declaration && ts.isFunctionDeclaration(declaration) ? declaration : declaration && ts.isVariableDeclaration(declaration) && declaration.initializer &&
        (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) ? declaration.initializer : null;
      if (fn) return this.returns(fn, path, this.bind(fn, args.map(arg => ({ node: arg, path: [], environment })), environment), visited);
      return unknown();
    }
    return unknown();
  }
  private bind(fn: ts.FunctionLikeDeclaration, arguments_: readonly Binding[], environment: Environment): Environment {
    const bindings = new Map(environment);
    fn.parameters.forEach((parameter, index) => {
      const argument = arguments_[index] ?? (parameter.initializer ? { node: parameter.initializer, path: [], environment } : undefined);
      if (!argument) return;
      const add = (name: ts.BindingName, path: readonly string[]) => {
        if (ts.isIdentifier(name)) { const symbol = this.symbol(name); if (symbol) bindings.set(symbol, { ...argument, path: [...argument.path, ...path] }); }
        else name.elements.forEach((element, position) => {
          if (ts.isOmittedExpression(element)) return;
          const key = ts.isArrayBindingPattern(name) ? String(position) : nameOf(element.propertyName ?? element.name);
          if (key) add(element.name, [...path, key]);
        });
      };
      add(parameter.name, []);
    });
    return bindings;
  }
  private returns(fn: ts.FunctionLikeDeclaration, path: Path, environment: Environment, parents: readonly ts.Node[]): Phrases {
    if (!fn.body) return unknown();
    if (!ts.isBlock(fn.body)) return this.resolve(fn.body, path, environment, parents);
    const expressions: ts.Expression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isReturnStatement(node) && node.expression) expressions.push(node.expression);
      else if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit);
    };
    ts.forEachChild(fn.body, visit);
    return expressions.length ? join(expressions.map(expression => this.resolve(expression, path, environment, parents))) : unknown();
  }
  private parameter(parameter: ts.ParameterDeclaration, path: Path, environment: Environment, parents: readonly ts.Node[]): Phrases {
    const fn = parameter.parent;
    if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return unknown();
    const call = fn.parent;
    if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return unknown();
    if (!['map', 'flatMap', 'filter', 'find', 'some', 'every'].includes(call.expression.name.text)) return unknown();
    return this.resolve(call.expression.expression, ['*', ...path], environment, parents);
  }
}
