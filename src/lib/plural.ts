/** Polish plural: plural(1, ["plik", "pliki", "plików"]) → "1 plik", 2–4 → "pliki", 5+ / 12–14 → "plików". */
export function plural(n: number, [one, few, many]: [string, string, string]): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word = n === 1 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many;
  return `${n} ${word}`;
}
