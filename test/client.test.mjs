import test from 'node:test';
import assert from 'node:assert/strict';

/** Exercise the browser bundle exactly as the DSH module loader would. */
function reactStub() {
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: Symbol('Fragment'),
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  };
}

test('客户端半注册侧栏入口', async () => {
  let captured;
  globalThis.window = {
    __ModuleLoader__: {
      load: (definition) => {
        captured = definition;
      },
    },
  };
  const styleTags = [];
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {} }),
    head: { appendChild: (tag) => styleTags.push(tag) },
    body: {},
    addEventListener: () => {},
  };
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.fetch = async () => ({ ok: false });
  globalThis.setInterval = () => 0;

  await import('../lib/client.js');
  assert.equal(captured.id, 'shipping-workbench');

  const require = (name) => {
    if (name === 'react') return reactStub();
    if (name === 'react-dom') return { createPortal: (element) => element };
    throw new Error(`unexpected require:${name}`);
  };
  const mod = captured.factory(require);
  assert.equal(mod.name, 'shipping-workbench');

  const registered = [];
  const ctx = {
    effect: (fn) => fn(),
    locale: { register: () => {}, bind: () => (key) => key },
    slots: {
      inject: (name, fn) => fn(),
      register: (options, component) => {
        registered.push({ options, component });
        return () => {};
      },
    },
  };
  mod.apply(ctx);
  assert.equal(registered.length, 2);
  const main = registered.find((item) => item.options.name === 'main');
  const panel = registered.find((item) => item.options.name === 'sidebar.panellist');
  assert.ok(main, '注册主区面板');
  assert.equal(main.options.key, 'shipping-workbench');
  assert.ok(panel, '注册侧栏面板入口');
  assert.equal(panel.options.id, 'shipping-workbench');
  assert.equal(panel.options.order, 5);
  assert.equal(typeof main.component, 'function');
  assert.equal(typeof panel.component, 'function');
});
