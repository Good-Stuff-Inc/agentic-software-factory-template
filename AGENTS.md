# Contribution instructions

These instructions apply to people and coding agents, including the Copilot
coding agent that the factory assigns to Bug issues.

## Your project

Replace this section with how to build and test the code in this repository.

- Install dependencies: `<your install command>`
- Build or type-check: `<your build command>`
- Test: `<your test command>`

## Before proposing a change

1. For a bug fix, write a focused regression test that fails before the fix,
   then make it pass.
2. Run the build and test commands above before handing off.
3. Keep the diff limited to the issue. Do not make drive-by refactors or
   unrelated fixes.

## Factory tooling

The factory's own tooling lives in `.github/factory/`. If you change anything
there, or in `.github/skills/`, run:

```bash
cd .github/factory
npm ci
npm run build
npm test
```

`.github/workflows/*.lock.yml` files are generated. Edit the matching `.md`
file, then run `gh aw compile` and commit both.

## Boundaries

Delivery scope ends at the default branch. Deployments, CD and work beyond the
default branch are out of scope.
