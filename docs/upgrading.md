# Upgrading from the pre-Stack prototype

The `RuntimeConfig`/`Stack` release cannot resume unfinished instances whose pinned configuration has no Stack manifest.
This includes configurations from commit `d292f8a6e2396aac148f45b5e33f2084df3621b5`.
Complete the following procedure with the previous controller before replacing its image or configuration.

1. Record the previous image digest, configuration revision, mounts, and credential-file locations for rollback.
   Keep the configuration Git history and diagnostic data. Do not copy credentials into tickets or logs.
2. Suspend new activations operationally: ask operators and integrations not to apply activation labels during the
   upgrade. Keep the previous controller running so existing instances can reach their terminal states.
3. Finish each existing instance, including manual merges and human gates. If an owner chooses cancellation instead,
   remove its activation label and wait for the previous controller to persist `cancelled` and stop its agent.
   Removing a label alone is not proof that cancellation completed.
4. Check every allowlisted repository, including closed tickets, for `agent-flow:managed` history and pending activation
   labels. Verify that all persisted control records are `done` or `cancelled`, no activation is pending, and no agent
   process remains. Stage labels alone are insufficient if a previous label write failed.
5. Stop the previous controller. Configure the new deployment from `config/runtime.example.yaml`, commit its Stack,
   logical agent catalog, and APM lockfiles, and pin the new configuration revision.
6. Start exactly one new controller. Wait for `/health/ready` to return 200 after provider bootstrap, confirm that no
   configuration error remains, then allow new activations. New work creates new instances and retains terminal history.

Never edit a control comment's `configRevision` to bypass this check. There is no automatic in-place migration of old
instances, and an empty work queue or `safeToRestart` does not prove that paused instances are finished.

## If the upgrade was started too early

Stop the new controller and restore the recorded previous image, configuration, and mounts. Run only that controller,
finish or cancel the remaining instances, and repeat the checks above. A missing Stack during bootstrap leaves the new
controller unready; it does not migrate the affected instance.

If new-format instances have already started, do not roll the old controller back over them. Stop new activations and
complete those instances with the new controller before a format downgrade. If that cannot be done, keep the service
stopped and plan an explicit migration; do not rewrite provider state or run two controllers against the same tickets.
