import { act, create } from "react-test-renderer";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { UxpDropdown, UxpDropdownProvider } from "../src/components/UxpDropdown";

const options = [
  { value: "a", label: "选项 A" },
  { value: "b", label: "选项 B" },
];

describe("UxpDropdown", () => {
  it("keeps the option list out of layout flow and removes the decorative arrow", () => {
    const css = readFileSync("src/styles.css", "utf8");
    expect(css).toMatch(/\.uxp-dropdown__list\s*\{[^}]*position:\s*absolute/s);
    expect(css).toMatch(/\.uxp-dropdown\s*\{[^}]*position:\s*relative/s);
    expect(css).not.toContain(".uxp-dropdown__arrow");
  });

  it("switches adjacent menus in one click and closes on selection or an outside pointer", () => {
    const changeA = vi.fn();
    const changeB = vi.fn();
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <UxpDropdownProvider>
          <UxpDropdown id="first" ariaLabel="第一个下拉" value="a" options={options} onChange={changeA} />
          <UxpDropdown id="second" ariaLabel="第二个下拉" value="b" options={options} onChange={changeB} />
        </UxpDropdownProvider>,
      );
    });

    const first = tree.root.findByProps({ "aria-label": "第一个下拉" });
    const second = tree.root.findByProps({ "aria-label": "第二个下拉" });
    act(() => first.props.onClick());
    expect(first.props["aria-expanded"]).toBe(true);
    expect(tree.root.findAllByProps({ className: "uxp-dropdown__arrow" })).toHaveLength(0);
    act(() => second.props.onClick());
    expect(first.props["aria-expanded"]).toBe(false);
    expect(second.props["aria-expanded"]).toBe(true);
    act(() => first.props.onClick());
    expect(first.props["aria-expanded"]).toBe(true);
    expect(second.props["aria-expanded"]).toBe(false);

    act(() => tree.root.findAllByProps({ role: "option" })[1].props.onClick());
    expect(changeA).toHaveBeenCalledWith("b");
    expect(first.props["aria-expanded"]).toBe(false);

    act(() => first.props.onClick());
    act(() => tree.root.findByProps({ className: "uxp-dropdown-scope" }).props.onPointerDownCapture({
      target: { closest: () => null },
    }));
    expect(first.props["aria-expanded"]).toBe(false);
  });

  it("supports Escape, arrows, Enter and a truly disabled trigger", () => {
    const onChange = vi.fn();
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <UxpDropdownProvider>
          <UxpDropdown id="keyboard" ariaLabel="键盘下拉" value="a" options={options} onChange={onChange} />
          <UxpDropdown id="disabled" ariaLabel="禁用下拉" value="a" options={options} onChange={vi.fn()} disabled />
        </UxpDropdownProvider>,
      );
    });
    const trigger = tree.root.findByProps({ "aria-label": "键盘下拉" });
    const preventDefault = vi.fn();
    act(() => trigger.props.onKeyDown({ key: "ArrowDown", preventDefault }));
    expect(trigger.props["aria-expanded"]).toBe(true);
    act(() => trigger.props.onKeyDown({ key: "ArrowDown", preventDefault }));
    act(() => trigger.props.onKeyDown({ key: "Enter", preventDefault }));
    expect(onChange).toHaveBeenCalledWith("b");
    expect(trigger.props["aria-expanded"]).toBe(false);

    act(() => trigger.props.onKeyDown({ key: "ArrowUp", preventDefault }));
    expect(trigger.props["aria-expanded"]).toBe(true);
    act(() => trigger.props.onKeyDown({ key: "Escape", preventDefault }));
    expect(trigger.props["aria-expanded"]).toBe(false);

    const disabled = tree.root.findByProps({ "aria-label": "禁用下拉" });
    expect(disabled.props.disabled).toBe(true);
    act(() => disabled.props.onClick());
    expect(disabled.props["aria-expanded"]).toBe(false);
  });
});
