import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudImage } from "../src/components/CloudImage";

afterEach(() => vi.unstubAllGlobals());

describe("cloud preview on the UXP DOM", () => {
  it("renders without image dimensions, load events, layout APIs or resize observers", () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("ResizeObserver", undefined);
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<CloudImage src="blob:original" alt="original" />); });
    const preview = tree.root.findByProps({ role: "img" });
    expect(preview.props.style).toMatchObject({ backgroundImage: 'url("blob:original")', backgroundSize: "contain" });
    expect(preview.props.style.opacity).toBeUndefined();
    expect(tree.root.findAllByType("img")).toHaveLength(0);
    act(() => { tree.update(<CloudImage src="blob:next" alt="next" />); });
    expect(preview.props.style.backgroundImage).toBe('url("blob:next")');
    expect(preview.props["aria-label"]).toBe("next");
    act(() => tree.unmount());
  });
});
