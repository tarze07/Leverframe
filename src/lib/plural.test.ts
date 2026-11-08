import { describe, expect, it } from "vitest";
import { plural } from "./plural";

describe("plural", () => {
  const forms: [string, string, string] = ["polecenie", "polecenia", "poleceń"];
  it("uses Polish plural forms", () => {
    expect([0, 1, 2, 4, 5, 12, 14, 22, 25, 112, 122].map((n) => plural(n, forms))).toEqual([
      "0 poleceń", "1 polecenie", "2 polecenia", "4 polecenia", "5 poleceń", "12 poleceń",
      "14 poleceń", "22 polecenia", "25 poleceń", "112 poleceń", "122 polecenia",
    ]);
  });
});
