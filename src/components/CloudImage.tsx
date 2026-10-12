// UXP supports background-size: contain, but does not expose naturalWidth/Height.
// Let its image renderer fit the bitmap without a hidden DOM measurement phase.
export function CloudImage({ src, alt }: { src: string; alt: string }) {
  return <div className="cloud-image-frame" role="img" aria-label={alt}
    style={{ backgroundImage: `url(${JSON.stringify(src)})`, backgroundSize: "contain", backgroundPosition: "center", backgroundRepeat: "no-repeat" }} />;
}
