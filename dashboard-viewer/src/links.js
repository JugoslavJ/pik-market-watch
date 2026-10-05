export function validAd(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "olx.ba" || url.hostname.endsWith(".olx.ba"))
    );
  } catch {
    return false;
  }
}

export function openAd(value) {
  if (validAd(value)) window.open(value, "_blank", "noopener,noreferrer");
}
