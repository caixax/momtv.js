# Changesets

Every change that should reach npm comes with a changeset: a small file saying which packages it touches, whether it is a patch, a minor or a major, and one line describing it.

```sh
pnpm changeset          # write one, after making a change
pnpm changeset:version  # turn them into versions and changelogs
pnpm release            # build and publish what changed
```

The four packages are linked: when several of them go out together, they go out under the same version.
