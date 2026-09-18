declare const __COHUB_RUNTIME_ENV__: "dev" | "prod";

(() => {
  const initialized = Symbol.for(`cohub.runtime.${__COHUB_RUNTIME_ENV__}.initialized`);
  const runtimeWindow = window as Window & {
    __cohub?: Record<string, unknown>;
    [initialized]?: boolean;
  };
  if (runtimeWindow[initialized]) return;
  runtimeWindow[initialized] = true;
  runtimeWindow.__cohub ??= {};

  console.log(
    `%c cohub%c.runtime %c ${__COHUB_RUNTIME_ENV__.toUpperCase()} %c Ready `,
    "background:#FF3E00;color:#fff;padding:5px 0 5px 9px;border-radius:5px 0 0 5px;font:700 12px/1.6 system-ui,sans-serif;",
    "background:#FF3E00;color:#fff;padding:5px 9px 5px 0;border-radius:0 5px 5px 0;font:500 12px/1.6 system-ui,sans-serif;",
    "background:#242428;color:#ddd;padding:5px 8px;margin-left:6px;border-radius:5px;font:600 10px/1.6 system-ui,sans-serif;letter-spacing:1px;",
    "color:#7d7d87;padding:5px 6px;font:400 12px/1.6 system-ui,sans-serif;",
  );
})();
