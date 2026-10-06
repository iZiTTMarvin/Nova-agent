const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { _electron: electron } = require(path.join(__dirname, '../tests/e2e/node_modules/@playwright/test'));

const repoRoot = path.resolve(__dirname, '..');
const artifactsDir = 'C:/Users/xuhaochen/.gemini/antigravity-ide/brain/8f2dea81-e722-453c-9614-cece9f8324f1';

async function captureTheme(theme, outFilename) {
  const profileRoot = path.join(os.tmpdir(), `nova-brand-capture-${theme}-${Date.now()}`);
  const userDataDir = path.join(profileRoot, 'userData');
  fs.mkdirSync(path.join(profileRoot, 'appdata'), { recursive: true });
  fs.mkdirSync(path.join(profileRoot, 'home'), { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  const env = {
    ...process.env,
    NODE_ENV: 'production',
    NOVA_E2E: '1',
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    APPDATA: path.join(profileRoot, 'appdata'),
    HOME: path.join(profileRoot, 'home'),
    USERPROFILE: path.join(profileRoot, 'home')
  };
  delete env.ELECTRON_RENDERER_URL;
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await electron.launch({
    args: [`--user-data-dir=${userDataDir}`, `--theme=${theme}`, repoRoot],
    cwd: repoRoot,
    env
  });

  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1200, height: 800 });

    // 等待启动 logo 壳渲染
    await page.waitForSelector('.startup-logo-shell', { state: 'attached' });
    // 入场弹性动效的最佳高光瞬间（~220ms）
    await page.waitForTimeout(220);

    const outPath = path.join(artifactsDir, outFilename);
    await page.screenshot({ path: outPath });
    console.log(`Saved screenshot to ${outPath}`);
  } finally {
    await app.close();
    try {
      fs.rmSync(profileRoot, { recursive: true, force: true });
    } catch (_) {}
  }
}

(async () => {
  console.log('Capturing dark theme startup screen...');
  await captureTheme('dark', 'startup-brand-dark.png');
  console.log('Capturing parchment/light theme startup screen...');
  await captureTheme('light', 'startup-brand-light.png');
  console.log('Finished capturing all brand screens!');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
