// Runtime no-op shim for @earendil-works/pi-tui.
// ui-config.ts imports these at module load; the interactive wizard only runs
// in a real TUI (ctx.hasUI + ctx.ui.custom), never inside the harness, so the
// classes are never instantiated here — empty stubs keep the import resolvable.
export class Container {
  addChild() {}
  clear() {}
  render() {
    return "";
  }
  invalidate() {}
}
export class Input {
  getValue() {
    return "";
  }
  handleInput() {}
}
export class SelectList {
  constructor(items = [], _height = 10) {
    this.items = items;
  }
  handleInput() {}
  setSelectedIndex() {}
  getSelectedItem() {
    return this.items[0];
  }
  onSelect = () => {};
  onCancel = () => {};
  onSelectionChange = () => {};
}
export class Text {
  constructor(text) {
    this.text = text;
  }
  render() {
    return this.text;
  }
}
export class DynamicBorder {
  constructor() {}
  render() {
    return "";
  }
}
export function getKeybindings() {
  return { matches: () => false };
}
