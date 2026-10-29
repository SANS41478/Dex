/**
 * 启动期环境防御（U-14）。
 *
 * `ELECTRON_RUN_AS_NODE` 只要**存在**就生效——`1`、`0`、`true`、空字符串都一样：
 * electron.exe 退化成纯 Node，不建窗口、不监听 DevTools 端口、`electron.app` 为 `undefined`。
 * （已实测：`ELECTRON_RUN_AS_NODE=0 electron --version` 打印的是 Node 的 `v24.20.0`；
 * 删掉变量才打印 Electron 的 `v44.3.0`。所以判定 MUST 按**存在性**，不能按取值。）
 *
 * 该变量由父进程传入（IDE / 自动化沙箱 / 测试脚本），本应用自己从不需要它。
 * 不拦的话失败形态很难查：Playwright 只报含义模糊的
 * `Process failed to launch!`，手跑则是 `Cannot read properties of undefined (reading 'whenReady')`。
 */

/** 环境正常返回 `null`；否则返回一句给人看的原因。 */
export function describeRunAsNode(env: NodeJS.ProcessEnv): string | null {
  if (env.ELECTRON_RUN_AS_NODE === undefined) return null
  return [
    '环境变量 ELECTRON_RUN_AS_NODE 存在，Electron 已退化为纯 Node 模式：',
    '窗口不会创建、DevTools 端口不会监听、electron.app 为 undefined。',
    '它由父进程（IDE / 自动化沙箱 / 测试脚本）传入，本应用不需要它。',
    '清除后重试即可；若由 Playwright 启动，请在 electron.launch 的 env 里把它删掉。',
  ].join('\n')
}
