# sample_test

Minimal ArkTS workspace fixture for MCP testing.

It is designed to exercise:

- component discovery (`@Entry`, `@Component`, `@Preview`, `@Reusable`, `@CustomDialog`)
- core decorated member discovery (`@State`, `@Prop`, `@StorageLink`, `@Watch`)
- cross-file imports between `.ets` files
- symbol lookup across `.ets` and `.ts`
- dependency tracing from an entry file

Suggested target files:

- `src/App.ets`
- `src/components/DialogPreview.ets`
- `src/components/ProfileCard.ets`
- `src/components/StatsPanel.ets`
- `src/utils/format.ts`
