import { createContext, runInContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Handler = (event: Record<string, unknown>) => unknown;

export class ReportElement {
  tagName: string;
  children: ReportElement[] = [];
  parentNode: ReportElement | null = null;
  owner: ReportDocument;
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  listeners = new Map<string, Handler[]>();
  className = '';
  text = '';
  disabled = false;
  hidden = false;
  open = false;
  value = '';
  type = '';
  src = '';
  href = '';
  tabIndex = 0;
  title = '';
  onload?: () => void;
  onerror?: () => void;
  viewBox = { baseVal: { width: 1000, height: 380 } };
  classList = {
    add: (...names: string[]) => {
      this.className = [...new Set([...this.className.split(' '), ...names])].join(' ');
    },
  };

  constructor(tag: string, owner: ReportDocument) {
    this.tagName = tag;
    this.owner = owner;
  }
  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join('');
  }
  set textContent(value: string) {
    this.text = String(value);
    this.replaceChildren();
  }
  get isConnected(): boolean {
    return this === this.owner.root || this.parentNode?.isConnected === true;
  }
  append(...nodes: ReportElement[]): void {
    for (const item of nodes) {
      item.remove();
      item.parentNode = this;
      this.children.push(item);
      if (item.tagName === 'script' && item.src) this.owner.scripts.push(item);
    }
  }
  prepend(item: ReportElement): void {
    item.remove();
    item.parentNode = this;
    this.children.unshift(item);
  }
  replaceChildren(...nodes: ReportElement[]): void {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }
  remove(): void {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }
  setAttribute(name: string, value: unknown): void {
    this.attributes.set(name, String(value));
    if (name === 'class') this.className = String(value);
    if (name === 'viewBox') {
      const values = String(value).split(' ').map(Number);
      this.viewBox.baseVal = { width: values[2]!, height: values[3]! };
    }
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  addEventListener(type: string, handler: Handler): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }
  async emit(type: string, extra: Record<string, unknown> = {}): Promise<void> {
    const event = { target: this, currentTarget: this, button: 0, pointerId: 1, preventDefault() {}, ...extra };
    await Promise.all((this.listeners.get(type) ?? []).map((handler) => handler(event)));
  }
  click(): Promise<void> {
    return this.disabled ? Promise.resolve() : this.emit('click');
  }
  showModal(): void {
    this.open = true;
    this.owner.activeElement = this;
  }
  close(): void {
    this.open = false;
    void this.emit('close');
  }
  focus(): void {
    this.owner.activeElement = this;
  }
  scrollIntoView(): void {
    this.owner.scrolledTo = this;
  }
  setPointerCapture(): void {}
  getBoundingClientRect() {
    return {
      width: 1000,
      height: this.viewBox.baseVal.height,
      left: 0,
      top: 0,
      right: 1000,
      bottom: this.viewBox.baseVal.height,
    };
  }
  querySelectorAll(selector: string): ReportElement[] {
    return this.children.flatMap((child) => [
      ...(matches(child, selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
}

function matches(element: ReportElement, selector: string): boolean {
  if (selector.startsWith('.')) return element.className.split(' ').includes(selector.slice(1));
  return element.tagName === selector;
}

class ReportDocument {
  root = new ReportElement('html', this);
  body = new ReportElement('body', this);
  head = new ReportElement('head', this);
  documentElement = this.root;
  scripts: ReportElement[] = [];
  ids = new Map<string, ReportElement>();
  activeElement: ReportElement | null = null;
  scrolledTo: ReportElement | null = null;
  constructor(data: string) {
    this.root.append(this.head, this.body);
    for (const [id, tag] of [
      ['app', 'main'],
      ['report-data', 'script'],
      ['report-links', 'aside'],
    ]) {
      const element = new ReportElement(tag!, this);
      this.ids.set(id!, element);
      this.body.append(element);
    }
    this.ids.get('report-data')!.textContent = data;
  }
  createElement(tag: string): ReportElement {
    return new ReportElement(tag, this);
  }
  createElementNS(_ns: string, tag: string): ReportElement {
    return this.createElement(tag);
  }
  getElementById(id: string): ReportElement | null {
    return this.ids.get(id) ?? null;
  }
}

export async function reportDom(file: string) {
  const html = readFileSync(file, 'utf8');
  const dataTag = '<script type="application/json" id="report-data">';
  const dataStart = html.indexOf(dataTag) + dataTag.length;
  const document = new ReportDocument(html.slice(dataStart, html.indexOf('</script>', dataStart)));
  const scriptStart = html.indexOf('<script type="module">') + '<script type="module">'.length;
  const script = html.slice(scriptStart, html.indexOf('</script>', scriptStart)).replace(/^export /gm, '');
  const frames: Array<() => void> = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const sandbox = createContext({
    document,
    window: { innerHeight: 1000, innerWidth: 1200 },
    Intl,
    URL,
    Blob,
    Response,
    DecompressionStream,
    atob,
    requestAnimationFrame: (fn: () => void) => {
      frames.push(fn);
    },
    ResizeObserver: class {
      fn: (entries: unknown[]) => void;
      constructor(fn: (entries: unknown[]) => void) {
        this.fn = fn;
      }
      observe() {
        this.fn([{ contentRect: { width: 1000 } }]);
      }
      disconnect() {}
    },
    setTimeout: (fn: () => void, time: number) => {
      const timer = setTimeout(fn, time);
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => {
      clearTimeout(timer);
      timers.delete(timer);
    },
  });
  await runInContext(`(async()=>{${script}})()`, sandbox);
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
    for (let count = 0; frames.length && count < 100; count++) frames.shift()!();
    await Promise.resolve();
  };
  await flush();
  return {
    document,
    flush,
    resolve(scriptNode: ReportElement) {
      const source = readFileSync(join(file, '..', scriptNode.src), 'utf8');
      runInContext(source, sandbox);
      scriptNode.onload?.();
    },
    dispose() {
      for (const timer of timers) clearTimeout(timer);
    },
  };
}
