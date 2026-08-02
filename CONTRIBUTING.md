# Contributing

## Testing convention

Test files use the **co-located `.test.ts`** convention (vitest default): each test file sits next to the source file it covers.

```
src/
├── engine.ts
├── engine.test.ts        # ✓ co-located
└── tools/
    ├── task.ts
    └── task.test.ts      # ✓ co-located
```

Do **not** use `__tests__/` subdirectories — that is a Jest-era holdover and the project has migrated away from it.
