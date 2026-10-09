import { expect, test } from "bun:test";
import { reconcileDesktopNativeCatalogRows } from "../src/codex/catalog/desktop-native-cache";

const kind = "codex-desktop-native-v1";
const old = { slug: "gpt-6-sol", opencodex_catalog_kind: kind, context_window: 100 };
const fresh = { ...old, context_window: 200 };

test("fresh Desktop rows replace prior copies and repeated syncs stay stable", () => {
  const merged = reconcileDesktopNativeCatalogRows([old, old], [fresh, fresh], true);
  expect(merged).toEqual([fresh]);
  expect(reconcileDesktopNativeCatalogRows(merged, [fresh], true)).toEqual(merged);
});

test("invalidated cache preserves one latest projected row and foreign rows", () => {
  const foreign = { slug: "custom/model", description: "user entry" };
  expect(reconcileDesktopNativeCatalogRows([foreign, old, fresh], [], false))
    .toEqual([foreign, fresh]);
});

test("authoritative empty cache removes previous Desktop rows", () => {
  expect(reconcileDesktopNativeCatalogRows([old], [], true)).toEqual([]);
});
