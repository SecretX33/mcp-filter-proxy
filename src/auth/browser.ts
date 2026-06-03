import open from "open";

/**
 * Opens a URL in the user's browser. Injectable so the OAuth flow can be driven
 * without a real browser (e.g. in tests).
 */
export type OpenBrowser = (url: string) => Promise<void>;

/**
 * Default opener: launches the system browser via `open`, always printing the URL to
 * stderr so the user can complete authorization manually if the browser does not open
 * (headless hosts, SSH sessions, etc.).
 */
export const openInBrowser: OpenBrowser = async (url) => {
  console.error(
    `\nAuthorization required. Opening your browser to:\n  ${url}\n` +
      `If it did not open, paste that URL into your browser to continue.\n`,
  );
  try {
    await open(url);
  } catch (err) {
    console.error(`Could not open a browser automatically: ${err}`);
  }
};
