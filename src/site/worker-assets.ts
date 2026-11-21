declare const __WATCHDOG_SITE_ASSETS__: Readonly<Record<string, string>>;

const TYPES: Readonly<Record<string, string>> = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  png: "image/png",
  woff2: "font/woff2",
  svg: "image/svg+xml",
};

/** Site Worker assets are bundled from the reviewed website/site directory. */
export const bundledSiteAssets = {
  async get(name: string) {
    if (!/^[a-z0-9][a-z0-9.-]{0,80}\.(?:css|js|svg|png|woff2)$/.test(name))
      return null;
    const encoded = __WATCHDOG_SITE_ASSETS__[name];
    if (!encoded) return null;
    const binary = atob(encoded);
    const body = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    const extension = name.split(".").at(-1) ?? "";
    const contentType = TYPES[extension];
    return contentType ? { body, contentType } : null;
  },
};
