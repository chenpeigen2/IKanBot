// 启动真实主进程（含托盘图标），再截任务栏托盘区
const { execSync } = require('child_process')
const { spawn } = require('child_process')
const path = require('path')

// 先启真正的应用（它会建托盘），等托盘出现
const app = spawn(process.execPath, ['.'], {
  cwd: path.resolve('.'),
  env: { ...process.env, IKAN_TRAY_PROBE: '1' },
  detached: false
})

setTimeout(() => {
  const ps =
    "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;" +
    "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;" +
    "$w=520;$h=90;$x=$b.Width-$w-4;$y=$b.Height-$h;" +
    "$bmp=New-Object System.Drawing.Bitmap($w,$h);" +
    "$g=[System.Drawing.Graphics]::FromImage($bmp);" +
    "$g.CopyFromScreen($x,$y,0,0,$bmp.Size);" +
    "$bmp.Save('D:/code/IKanBot/out/shots/traybar.png',[System.Drawing.Imaging.ImageFormat]::Png)"
  try {
    execSync('powershell -NoProfile -Command "' + ps + '"', { timeout: 20000 })
    console.log('saved traybar')
  } catch (e) { console.log('PS err') }
  app.kill()
  process.exit(0)
}, 7000)
