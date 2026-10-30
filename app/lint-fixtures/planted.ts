// Lint self-test fixture (`pnpm --dir app lint:self-test`): every line below
// must trip .oxlintrc.json, so a lint config that stops failing is caught.
// Not part of any package, tsconfig, or lint path.
export function planted(x: number, y: any): number {
  if (x == 1) {
    debugger;
  }
  var unused = 2;
  return y;
}
