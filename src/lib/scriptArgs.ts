/** 스크립트 인자. `pnpm start -- --dry-run`처럼 pnpm이 넘기는 맨 앞의 `--`는 제거한다. */
export function scriptArgs(argv: readonly string[] = process.argv): string[] {
  const args = argv.slice(2);
  return args[0] === '--' ? args.slice(1) : args;
}
