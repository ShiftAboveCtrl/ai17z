import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const webSrc = resolve(root, 'apps/web/src');

/**
 * A hook after an early return is a blank screen, not a warning.
 *
 * React counts hooks by call order. A component that returns early on its
 * loading state calls fewer of them on the first render than on the second, and
 * React answers that with `Rendered more hooks than during the previous render`
 * -- a throw, during render, which unmounts the entire tree. What is left is an
 * empty `#root` over the app's own near-black ground, so it reads as a black
 * screen with no message and nothing in it to search for.
 *
 * That is not hypothetical. `Home` grew a `useState` below its
 * `if (loading && !data) return <Loading/>`, and every visit to the agent list
 * -- on every installation, empty or not -- flashed the interface and then went
 * black. It shipped, because nothing here could see it: TypeScript cannot, no
 * test rendered the page, and this repository has no ESLint, so
 * `react-hooks/rules-of-hooks` has never run over it.
 *
 * This is the cheap half of that rule, done properly with the TypeScript AST
 * rather than a regular expression, and scoped to the mistake that actually
 * cost something: a hook that a `return` above it can skip.
 */

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
    else if (entry.endsWith('.tsx') || entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

function isHookCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const name = ts.isIdentifier(node.expression)
    ? node.expression.text
    : ts.isPropertyAccessExpression(node.expression)
      ? node.expression.name.text
      : '';
  return /^use[A-Z]/.test(name);
}

/** The name a hook was called by, for a message that says which one. */
function hookName(node: ts.CallExpression): string {
  return ts.isIdentifier(node.expression)
    ? node.expression.text
    : ts.isPropertyAccessExpression(node.expression)
      ? node.expression.name.text
      : 'a hook';
}

/**
 * Does this statement hand control back to the caller?
 *
 * A bare `return`, or an `if` whose branch does. Not a `return` nested inside a
 * callback -- `onClick={() => { ... return; }}` returns from the callback, and
 * counting it would flag most of the codebase.
 */
function exitsEarly(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement)) return true;
  if (ts.isIfStatement(statement)) {
    const branches = [statement.thenStatement, statement.elseStatement].filter(Boolean) as ts.Statement[];
    return branches.some((branch) =>
      ts.isBlock(branch) ? branch.statements.some(ts.isReturnStatement) : ts.isReturnStatement(branch),
    );
  }
  return false;
}

interface Finding {
  file: string;
  component: string;
  hook: string;
  line: number;
}

/** Hooks in this body that a `return` earlier in the same body could skip. */
function findingsIn(body: ts.Block, component: string, source: ts.SourceFile, file: string): Finding[] {
  const found: Finding[] = [];
  let returned = false;

  for (const statement of body.statements) {
    if (returned) {
      // Only this body's own hooks. A nested function has its own hook order
      // and React judges it separately.
      const visit = (node: ts.Node): void => {
        if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return;
        if (isHookCall(node)) {
          found.push({
            file,
            component,
            hook: hookName(node),
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          });
        }
        ts.forEachChild(node, visit);
      };
      visit(statement);
    }
    if (exitsEarly(statement)) returned = true;
  }

  return found;
}

function scan(file: string): Finding[] {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const shortName = relative(root, file).replace(/\\/g, '/');
  const found: Finding[] = [];

  const visit = (node: ts.Node): void => {
    // A component or a custom hook: PascalCase, or a name beginning `use`.
    let name: string | undefined;
    let body: ts.Block | undefined;

    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      name = node.name.text;
      body = node.body;
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
      node.initializer.body &&
      ts.isBlock(node.initializer.body)
    ) {
      name = node.name.text;
      body = node.initializer.body;
    }

    if (name && body && (/^[A-Z]/.test(name) || /^use[A-Z]/.test(name))) {
      found.push(...findingsIn(body, name, source, shortName));
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return found;
}

describe('hooks that an early return can skip', () => {
  const files = tsxFiles(webSrc);

  it('has something to look at', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('finds none in the web application', () => {
    const found = files.flatMap(scan);
    const described = found.map((f) => `  ${f.file}:${f.line}  ${f.component} calls ${f.hook} after an early return`);
    expect(found, `a hook here is a blank screen, not a warning:\n${described.join('\n')}`).toEqual([]);
  });

  it('would notice the shape that shipped', () => {
    // The mistake itself, so a green result means the scanner works rather
    // than that it looked at nothing.
    const source = ts.createSourceFile(
      'Sample.tsx',
      `export function Home() {
         const { data, loading } = useResource('/api/agents');
         if (loading && !data) return null;
         const [open, setOpen] = useState(false);
         return <div onClick={() => setOpen(!open)} />;
       }`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const body = (source.statements[0] as ts.FunctionDeclaration).body!;
    const found = findingsIn(body, 'Home', source, 'Sample.tsx');
    expect(found.map((f) => f.hook)).toEqual(['useState']);
  });

  it('does not flag a return inside a callback, which returns from the callback', () => {
    const source = ts.createSourceFile(
      'Sample.tsx',
      `export function Panel() {
         const save = () => { if (!ok) return; send(); };
         const [open, setOpen] = useState(false);
         return <div />;
       }`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const body = (source.statements[0] as ts.FunctionDeclaration).body!;
    expect(findingsIn(body, 'Panel', source, 'Sample.tsx')).toEqual([]);
  });
});

/**
 * And the other half: a render error that gets through is still legible.
 *
 * The scanner above catches one cause. The boundary catches every cause, which
 * is why both exist -- the point is not that this particular bug never returns,
 * it is that the next one arrives with a name on it instead of as a black
 * rectangle.
 */
describe('a render error is never a blank screen', () => {
  const app = readFileSync(resolve(webSrc, 'App.tsx'), 'utf8');
  const main = readFileSync(resolve(webSrc, 'main.tsx'), 'utf8');
  const crash = readFileSync(resolve(webSrc, 'components/Crash.tsx'), 'utf8');

  it('has a boundary, which React only honours as a class', () => {
    // getDerivedStateFromError and componentDidCatch have no hook equivalent.
    // A function component cannot be an error boundary however it is written.
    expect(crash).toContain('class Crash extends Component');
    expect(crash).toContain('getDerivedStateFromError');
    expect(crash).toContain('componentDidCatch');
  });

  it('wraps the routes, so one bad screen does not take the navigation with it', () => {
    expect(app).toContain('<Crash area="page">');
    const boundary = app.indexOf('<Crash');
    const bar = app.indexOf('<TopBar');
    expect(bar, 'the header must stay outside the boundary or there is nowhere to go').toBeLessThan(boundary);
  });

  it('wraps everything the route boundary sits inside', () => {
    // The session provider, the top bar and the router itself are all outside
    // the inner boundary. Without this one, a fault in any of them is still a
    // black screen.
    expect(main).toContain('<Crash area="application">');
    expect(main.indexOf('<Crash')).toBeLessThan(main.indexOf('<BrowserRouter>'));
  });

  it('shows the message and where it came from, since that is the whole point', () => {
    expect(crash).toContain('error.message');
    expect(crash).toContain('componentStack');
  });

  it('does not retry on its own', () => {
    // A render error is almost never transient. A boundary that re-renders by
    // itself turns a reproducible crash into a flicker nobody can report.
    expect(crash).not.toMatch(/setTimeout\([^)]*this\.setState/);
    expect(crash).toContain('window.location.reload()');
  });
});

/**
 * An effect that takes focus must not re-run on every render.
 *
 * `Modal` focused its dialog at the end of an effect whose dependency list was
 * `[open, onClose]`. Every caller passes `onClose={() => setThing(null)}` -- a
 * new function each render -- so the list never compared equal, the effect ran
 * again after every render, and the render caused by typing a character moved
 * the caret out of the field and onto the dialog. One character, then click
 * again. It applied to every form in every modal in the application.
 *
 * Measured with the fix in and out, by typing into the model editor and
 * counting keystrokes that lost the caret: three of three lost with the old
 * dependency list, none of three with the new one.
 *
 * Two rules, because the second is the one that generalises: nothing may call
 * focus() from an effect that depends on a function prop, and this particular
 * effect keeps its close handler in a ref.
 */
describe('taking focus is a thing you do once', () => {
  const ui = readFileSync(resolve(webSrc, 'components/ui.tsx'), 'utf8');

  it('focuses the dialog only when it opens', () => {
    const effect = ui.slice(ui.indexOf('export function Modal'));
    const deps = effect.match(/\}, \[([^\]]*)\]\);/)?.[1] ?? '';
    expect(deps.replace(/\s/g, ''), 'the focus effect depends on more than open').toBe('open');
  });

  it('holds the close handler in a ref instead', () => {
    // Escape still has to close it, and that must not cost a dependency.
    expect(ui).toContain('closeRef.current');
    expect(ui).toMatch(/closeRef\.current = onClose/);
  });

  it('is the only place in the interface that moves focus', () => {
    // A second one would have to make the same argument, and would not be
    // covered by the check above.
    const callers = tsxFiles(webSrc).filter((file) => {
      const text = readFileSync(file, 'utf8');
      return /(?<!\/\/ .*)\.focus\(\)/.test(text.replace(/^\s*\/\/.*$/gm, ''));
    });
    expect(callers.map((f) => f.replace(/\\/g, '/').split('/apps/web/src/')[1])).toEqual(['components/ui.tsx']);
  });
});
