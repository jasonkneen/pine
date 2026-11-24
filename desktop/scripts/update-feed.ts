// What a release carries for the app's own updater (Squirrel.Mac, through Electron's autoUpdater
// with a JSON feed), once for each kind of Mac: the app zipped, and a feed that points at that zip.
// scripts/pack.mjs writes both beside the disk image, and the release workflow uploads them.

// The download path and the feed's name are the app's own (electron/updates.ts), which looks for this feed.
import { DOWNLOADS, feedName } from "../electron/updates.ts";

/**
 * The names of the zip and the feed for a release and a kind of Mac, and the feed's content.
 * The feed's `url` is made from the version and the arch alone, on that release's own tag (never
 * `latest/download`), so that an app updates to exactly the release whose feed it read.
 */
export function updateFeed(version: string, arch: string, published: Date) {
	// Only a release's version: anything else would make an address on another path.
	if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`"${version}" is not the version of a release (like 0.38.0)`);
	if (arch !== "arm64" && arch !== "x64") throw new Error(`the kind of Mac is arm64 or x64, not "${arch}"`);
	const zip = `Pine-${version}-${arch}.zip`;
	return {
		files: { zip, feed: feedName(arch) },
		json: { url: `${DOWNLOADS}/v${version}/${zip}`, name: version, pub_date: published.toISOString() },
	};
}
