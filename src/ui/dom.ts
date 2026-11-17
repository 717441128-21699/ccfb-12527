/** 极简 DOM 辅助函数，避免引入框架 */

export type Attrs = Record<string, string | boolean | number>;

type Child = Node | string;
type Children = Child | Child[];

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, children?: Children): HTMLElementTagNameMap[K];
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs, children?: Children): HTMLElementTagNameMap[K];
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrsOrChildren?: Attrs | Children,
  maybeChildren: Children = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const isAttrs = (v: unknown): v is Attrs => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Node);
  // 第二参数若不是 attrs 对象，则视为 children
  const attrs = isAttrs(attrsOrChildren) ? attrsOrChildren : {};
  const rawChildren = isAttrs(attrsOrChildren) ? maybeChildren : attrsOrChildren;
  const children = Array.isArray(rawChildren) ? rawChildren : rawChildren === undefined ? [] : [rawChildren];
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = String(v);
    else if (k === 'text') node.textContent = String(v);
    else if (typeof v === 'boolean') {
      if (v) node.setAttribute(k, '');
    } else {
      node.setAttribute(k, String(v));
    }
  }
  for (const child of children) {
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
}

export function clearNode(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function toast(message: string): void {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const box = el('div', { class: 'toast' }, [message]);
  document.body.append(box);
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.remove(), 2400);
}

export function fmtCents(c: number): string {
  const sign = c > 0 ? '+' : '';
  return `${sign}${c.toFixed(1)}`;
}

export function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}
