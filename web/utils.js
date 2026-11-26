export const $ = id => document.getElementById(id);
export function element(tag, text, parent) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  parent?.append(node);
  return node;
}
export function button(label, parent, action) {
  const node = element('button', label, parent);
  node.type = 'button';
  node.onclick = action;
  return node;
}
export function field(parent, title, value, type = 'text') {
  const input = element('input', null, element('label', title, parent));
  input.type = type;
  input.value = value;
  return input;
}
export function options(select, entries, current) {
  select.replaceChildren(...entries.map(([value, label]) => new Option(label, value)));
  if (current != null) select.value = current;
}
export function download(name, contents, type = 'text/plain') {
  const url = URL.createObjectURL(contents instanceof Blob ? contents : new Blob([contents], {type}));
  const link = element('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function canvasContext(canvas) {
  const {width, height} = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  return {ctx, width, height};
}

export function palette(canvas, ...names) {
  const style = getComputedStyle(canvas);
  return names.map(name => style.getPropertyValue('--' + name).trim());
}

export function engineering(value, unit) {
  const prefixes = ['f', 'p', 'n', 'µ', 'm', '', 'k', 'M', 'G', 'T'];
  if (value === 0) return '0 ' + unit;
  const exponent = Math.max(-5, Math.min(4, Math.floor(Math.log10(Math.abs(value)) / 3)));
  const amount = Number((value / 10 ** (3 * exponent)).toPrecision(4));
  return amount + ' ' + prefixes[exponent + 5] + unit;
}
