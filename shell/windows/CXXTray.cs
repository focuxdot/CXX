// CXX Windows tray shell.
//
// Thin view: each action shells out to the bundled daemon and parses one JSON
// object from stdout. The daemon lifecycle is owned by Task Scheduler.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace CXX
{
    static class Program
    {
        static string DaemonPath;
        const string MutexName = "Local\\CXXRemoteTray";
        const string PairEventName = "Local\\CXXRemoteTrayPair";

        [STAThread]
        static void Main(string[] args)
        {
            DaemonPath = ResolveDaemon(args);
            bool openPair = HasFlag(args, "--pair");
            if (DaemonPath == null)
            {
                MessageBox.Show(L("找不到后台程序。请重新安装 CXX，或设置 CXX_DAEMON_BIN。", "The background daemon was not found. Reinstall CXX or set CXX_DAEMON_BIN."), "CXX");
                return;
            }

            bool created;
            using (var mutex = new Mutex(true, MutexName, out created))
            {
                if (!created)
                {
                    if (openPair) SignalPairWindow();
                    return;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                using (var pairEvent = new EventWaitHandle(openPair, EventResetMode.AutoReset, PairEventName))
                    Application.Run(new TrayContext(DaemonPath, pairEvent, openPair));
            }
        }

        static bool HasFlag(string[] args, string flag)
        {
            foreach (var a in args)
                if (string.Equals(a, flag, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        static void SignalPairWindow()
        {
            try
            {
                using (var ev = EventWaitHandle.OpenExisting(PairEventName))
                    ev.Set();
            }
            catch { }
        }

        static string ResolveDaemon(string[] args)
        {
            foreach (var arg in args)
                if (!arg.StartsWith("--", StringComparison.Ordinal) && File.Exists(arg))
                    return Path.GetFullPath(arg);
            string env = Environment.GetEnvironmentVariable("CXX_DAEMON_BIN");
            if (!string.IsNullOrEmpty(env) && File.Exists(env)) return Path.GetFullPath(env);
            string resourceDaemon = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "resources", "cxx-daemon.exe");
            if (File.Exists(resourceDaemon)) return Path.GetFullPath(resourceDaemon);
            string nextToTray = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "cxx-daemon.exe");
            if (File.Exists(nextToTray)) return Path.GetFullPath(nextToTray);
            return null;
        }

        static bool IsChinese()
        {
            return CultureInfo.CurrentUICulture.TwoLetterISOLanguageName.Equals("zh", StringComparison.OrdinalIgnoreCase);
        }

        public static string L(string zh, string en) { return IsChinese() ? zh : en; }
    }

    static class I18n
    {
        public static string L(string zh, string en) { return Program.L(zh, en); }
    }

    static class Backend
    {
        public static string Daemon;

        static string Quote(string s) { return "\"" + s + "\""; }

        public static Dictionary<string, object> Call(params string[] args)
        {
            try
            {
                var sb = new StringBuilder();
                foreach (var a in args)
                {
                    if (sb.Length > 0) sb.Append(' ');
                    sb.Append(Quote(a));
                }
                var psi = new ProcessStartInfo
                {
                    FileName = Daemon,
                    Arguments = sb.ToString(),
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                    StandardOutputEncoding = Encoding.UTF8,
                };
                using (var p = Process.Start(psi))
                {
                    var errThread = new Thread(delegate() { try { p.StandardError.ReadToEnd(); } catch { } }) { IsBackground = true };
                    errThread.Start();
                    string outText = p.StandardOutput.ReadToEnd();
                    errThread.Join();
                    p.WaitForExit();
                    var ser = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
                    var obj = ser.DeserializeObject(outText) as Dictionary<string, object>;
                    return obj ?? new Dictionary<string, object>();
                }
            }
            catch (Exception ex)
            {
                return new Dictionary<string, object> { { "error", I18n.L("无法启动后端: ", "Failed to launch backend: ") + ex.Message } };
            }
        }

        public static Dictionary<string, object> CallWithInput(string command, string json)
        {
            string tmp = Path.Combine(Path.GetTempPath(), "cxx-tray-" + Guid.NewGuid().ToString("N") + ".json");
            try
            {
                File.WriteAllText(tmp, json, new UTF8Encoding(false));
                return Call(command, tmp);
            }
            finally
            {
                try { File.Delete(tmp); } catch { }
            }
        }

        public static string Str(Dictionary<string, object> d, string k)
        {
            return d != null && d.ContainsKey(k) && d[k] != null ? d[k].ToString() : null;
        }

        public static bool Bool(Dictionary<string, object> d, string k)
        {
            return d != null && d.ContainsKey(k) && d[k] is bool && (bool)d[k];
        }

        public static long Long(Dictionary<string, object> d, string k)
        {
            if (d == null || !d.ContainsKey(k) || d[k] == null) return 0;
            try { return Convert.ToInt64(d[k]); } catch { return 0; }
        }

        public static bool HasKey(Dictionary<string, object> d, string k)
        {
            return d != null && d.ContainsKey(k) && d[k] != null;
        }
    }

    enum IconState { Disabled, Running, Warning }

    static class TrayIcons
    {
        [DllImport("user32.dll", SetLastError = true)]
        static extern bool DestroyIcon(IntPtr handle);

        static readonly Dictionary<IconState, Icon> cache = new Dictionary<IconState, Icon>();
        static string assetPath;

        public static void Configure(string path)
        {
            if (string.Equals(assetPath, path, StringComparison.OrdinalIgnoreCase)) return;
            assetPath = path;
            foreach (var icon in cache.Values)
            {
                try { icon.Dispose(); } catch { }
            }
            cache.Clear();
        }

        public static Icon Get(IconState state)
        {
            Icon icon;
            if (cache.TryGetValue(state, out icon)) return icon;
            icon = Build(state);
            cache[state] = icon;
            return icon;
        }

        static Icon Build(IconState state)
        {
            var assetIcon = BuildFromAsset(state);
            return assetIcon ?? BuildFallback(state);
        }

        static Icon BuildFromAsset(IconState state)
        {
            if (string.IsNullOrEmpty(assetPath) || !File.Exists(assetPath)) return null;
            try
            {
                using (var src = new Bitmap(assetPath))
                using (var bmp = new Bitmap(32, 32))
                using (var g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.HighQuality;
                    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g.Clear(Color.Transparent);
                    float scale = Math.Min(26f / src.Width, 26f / src.Height);
                    int w = Math.Max(1, (int)Math.Round(src.Width * scale));
                    int h = Math.Max(1, (int)Math.Round(src.Height * scale));
                    int x = (32 - w) / 2;
                    int y = (32 - h) / 2;

                    if (state == IconState.Disabled)
                    {
                        using (var ia = new System.Drawing.Imaging.ImageAttributes())
                        {
                            var matrix = new System.Drawing.Imaging.ColorMatrix(new float[][]
                            {
                                new float[] {0.30f, 0.30f, 0.30f, 0, 0},
                                new float[] {0.59f, 0.59f, 0.59f, 0, 0},
                                new float[] {0.11f, 0.11f, 0.11f, 0, 0},
                                new float[] {0, 0, 0, 0.55f, 0},
                                new float[] {0, 0, 0, 0, 1},
                            });
                            ia.SetColorMatrix(matrix);
                            g.DrawImage(src, new Rectangle(x, y, w, h), 0, 0, src.Width, src.Height, GraphicsUnit.Pixel, ia);
                        }
                        using (var slash = new Pen(Color.FromArgb(205, 70, 70), 2.4f))
                            g.DrawLine(slash, 5, 27, 27, 5);
                    }
                    else
                    {
                        g.DrawImage(src, x, y, w, h);
                        if (state == IconState.Warning)
                        {
                            using (var f = new Font("Segoe UI", 12, FontStyle.Bold))
                            using (var b = new SolidBrush(Color.FromArgb(230, 90, 40)))
                                g.DrawString("!", f, b, 20, 13);
                        }
                    }
                    return IconFromBitmap(bmp);
                }
            }
            catch
            {
                return null;
            }
        }

        static Icon BuildFallback(IconState state)
        {
            using (var bmp = new Bitmap(32, 32))
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                Color c = state == IconState.Running ? Color.FromArgb(60, 180, 95)
                        : state == IconState.Warning ? Color.FromArgb(230, 150, 40)
                        : Color.FromArgb(145, 145, 145);
                using (var pen = new Pen(c, 2.4f))
                using (var dot = new SolidBrush(c))
                {
                    g.DrawArc(pen, 6, 6, 20, 20, 200, 50);
                    g.DrawArc(pen, 2, 2, 28, 28, 200, 50);
                    g.FillEllipse(dot, 6, 22, 6, 6);
                }
                if (state == IconState.Disabled)
                {
                    using (var slash = new Pen(Color.FromArgb(205, 70, 70), 2.6f))
                        g.DrawLine(slash, 5, 27, 27, 5);
                }
                if (state == IconState.Warning)
                {
                    using (var f = new Font("Segoe UI", 12, FontStyle.Bold))
                        g.DrawString("!", f, Brushes.OrangeRed, 18, 12);
                }
                return IconFromBitmap(bmp);
            }
        }

        static Icon IconFromBitmap(Bitmap bmp)
        {
            IntPtr hicon = bmp.GetHicon();
            try
            {
                using (var tmp = Icon.FromHandle(hicon))
                    return (Icon)tmp.Clone();
            }
            finally
            {
                DestroyIcon(hicon);
            }
        }
    }

    class TrayContext : ApplicationContext
    {
        readonly NotifyIcon tray;
        readonly List<Form> windows = new List<Form>();
        readonly EventWaitHandle pairEvent;
        readonly System.Windows.Forms.Timer pairTimer;
        const int RemoteStartupTimeoutMs = 15000;
        const int RemoteStartupPollMs = 500;
        const string SupportIssuesUrl = "https://github.com/focuxdot/CXX/issues";

        static readonly Font FontBase = new Font("Microsoft YaHei", 9f);
        static readonly Font FontTitle = new Font("Microsoft YaHei", 14, FontStyle.Bold);
        static readonly Font FontSection = new Font("Microsoft YaHei", 10, FontStyle.Bold);
        static readonly Font FontRowName = new Font("Microsoft YaHei", 9.5f);
        static readonly Font FontRowSub = new Font("Microsoft YaHei", 8f);

        public TrayContext(string daemon, EventWaitHandle pairEvent, bool openPair)
        {
            Backend.Daemon = daemon;
            this.pairEvent = pairEvent;
            TrayIcons.Configure(ResolveTrayIcon());
            tray = new NotifyIcon
            {
                Visible = true,
                Icon = TrayIcons.Get(IconState.Disabled),
                Text = "CXX Remote",
                ContextMenuStrip = new ContextMenuStrip(),
            };
            tray.ContextMenuStrip.Opening += delegate(object s, System.ComponentModel.CancelEventArgs e) { e.Cancel = false; RebuildMenu(); };
            RefreshIcon(Backend.Call("status"));

            pairTimer = new System.Windows.Forms.Timer { Interval = 400 };
            pairTimer.Tick += delegate
            {
                if (this.pairEvent.WaitOne(0)) DoPair();
            };
            pairTimer.Start();
            if (openPair) pairEvent.Set();
        }

        static string ResolveTrayIcon()
        {
            string resourceIcon = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "resources", "menubar.png");
            if (File.Exists(resourceIcon)) return resourceIcon;
            string cwdIcon = Path.Combine(Environment.CurrentDirectory, "web", "icons", "menubar.png");
            if (File.Exists(cwdIcon)) return cwdIcon;
            return null;
        }

        void RefreshIcon(Dictionary<string, object> st)
        {
            bool enabled = Backend.Bool(st, "enabled");
            bool running = Backend.Bool(st, "running");
            IconState s = !enabled ? IconState.Disabled : (running ? IconState.Running : IconState.Warning);
            tray.Icon = TrayIcons.Get(s);
            tray.Text = !enabled ? I18n.L("CXX 远程：未启用", "CXX Remote: off")
                      : running ? I18n.L("CXX 远程：运行中", "CXX Remote: running")
                      : I18n.L("CXX 远程：已启用但未运行", "CXX Remote: enabled but not running");
        }

        void RebuildMenu()
        {
            var st = Backend.Call("status");
            RefreshIcon(st);
            bool enabled = Backend.Bool(st, "enabled");
            bool running = Backend.Bool(st, "running");
            long deviceCount = Backend.Long(st, "deviceCount");

            var m = tray.ContextMenuStrip;
            m.Items.Clear();

            string stateText = !enabled ? I18n.L("远程未开启", "Remote is off")
                : (running ? I18n.L("远程运行中", "Remote is running") : I18n.L("已启用但未运行", "Enabled but not running"));
            AddInfo(m, stateText);
            if (enabled) AddInfo(m, I18n.L("已配对设备：", "Paired devices: ") + deviceCount);
            m.Items.Add(new ToolStripSeparator());

            if (enabled)
            {
                AddItem(m, I18n.L("扫码配对...", "Pair with QR..."), delegate { DoPair(); });
                AddItem(m, I18n.L("已配对设备...", "Paired devices..."), delegate { DoDevices(); });
                AddItem(m, I18n.L("通知设置...", "Notifications..."), delegate { DoNotify(); });
                m.Items.Add(new ToolStripSeparator());
                AddItem(m, I18n.L("停用远程", "Disable remote"), delegate { DoDisable(); });
            }
            else
            {
                AddItem(m, I18n.L("扫码配对手机...", "Pair phone with QR..."), delegate { DoPair(); });
            }
            m.Items.Add(new ToolStripSeparator());
            AddItem(m, I18n.L("反馈问题", "Report an issue"), delegate { DoReportIssue(); });
            AddItem(m, enabled ? I18n.L("退出托盘（远程继续运行）", "Quit tray (remote keeps running)") : I18n.L("退出托盘", "Quit tray"), delegate { DoQuit(); });
        }

        static void AddInfo(ContextMenuStrip m, string text)
        {
            m.Items.Add(new ToolStripMenuItem(text) { Enabled = false });
        }

        static void AddItem(ContextMenuStrip m, string text, EventHandler onClick)
        {
            var it = new ToolStripMenuItem(text);
            it.Click += onClick;
            m.Items.Add(it);
        }

        void DoDisable()
        {
            Backend.Call("disable");
            RefreshIcon(Backend.Call("status"));
        }

        void DoPair()
        {
            var st = Backend.Call("status");
            if (!Backend.Bool(st, "enabled") || !Backend.Bool(st, "running"))
            {
                Cursor.Current = Cursors.WaitCursor;
                var en = Backend.Call("enable");
                if (Backend.HasKey(en, "error"))
                {
                    Cursor.Current = Cursors.Default;
                    Alert(I18n.L("开启失败", "Enable failed"), Backend.Str(en, "error"));
                    return;
                }
                st = WaitForRemoteRunning(RemoteStartupTimeoutMs);
                Cursor.Current = Cursors.Default;
                RefreshIcon(st);
                if (!Backend.Bool(st, "running"))
                {
                    Alert(
                        I18n.L("后台启动失败", "Background service failed to start"),
                        I18n.L(
                            "CXX 已开启计划任务，但后台服务没有成功运行。请查看日志：",
                            "CXX enabled the scheduled task, but the background service is not running. Check the log: "
                        ) + DaemonLogPath() + "\n\n" +
                        I18n.L(
                            "如果仍然无法解决，请带上这份日志到 GitHub Issues 反馈：",
                            "If this still does not work, include this log when reporting the issue on GitHub Issues: "
                        ) + SupportIssuesUrl
                    );
                    return;
                }
            }
            var res = Backend.Call("pair");
            string url = Backend.Str(res, "url");
            if (url == null) { Alert(I18n.L("配对失败", "Pairing failed"), Backend.Str(res, "error") ?? I18n.L("未知错误", "Unknown error")); return; }
            ShowQR(url, Backend.Str(res, "qrPath"));
        }

        Dictionary<string, object> WaitForRemoteRunning(int timeoutMs)
        {
            var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            Dictionary<string, object> st = null;
            while (DateTime.UtcNow < deadline)
            {
                st = Backend.Call("status");
                if (Backend.Bool(st, "running")) return st;
                Application.DoEvents();
                Thread.Sleep(RemoteStartupPollMs);
            }
            return st ?? Backend.Call("status");
        }

        static string DaemonLogPath()
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".cxx",
                "remote",
                "daemon.log"
            );
        }

        void DoDevices()
        {
            ShowDevices(Backend.Call("devices"));
        }

        void DoNotify()
        {
            ShowNotify();
        }

        void DoQuit()
        {
            pairTimer.Stop();
            pairTimer.Dispose();
            tray.Visible = false;
            tray.Dispose();
            ExitThread();
        }

        void DoReportIssue()
        {
            try
            {
                Process.Start(new ProcessStartInfo { FileName = SupportIssuesUrl, UseShellExecute = true });
            }
            catch (Exception ex)
            {
                Alert(I18n.L("无法打开链接", "Could not open link"), ex.Message + "\n\n" + SupportIssuesUrl);
            }
        }

        void ShowQR(string url, string qrPath)
        {
            var form = MakeWindow(I18n.L("微信扫码 · 配对 CXX", "Pair CXX"), 420, 620);
            var root = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 1,
                RowCount = 7,
                AutoScroll = true,
                Padding = new Padding(26, 20, 26, 20),
            };
            root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
            for (int i = 0; i < 7; i++) root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            form.Controls.Add(root);

            Action<Control, int> addCentered = delegate(Control c, int bottom)
            {
                c.Anchor = AnchorStyles.None;
                c.Margin = new Padding(0, 0, 0, bottom);
                root.Controls.Add(c);
            };

            addCentered(new Label { Text = I18n.L("微信扫码 · 配对 CXX", "Pair CXX"), Font = FontTitle, AutoSize = true }, 6);
            addCentered(new Label { Text = I18n.L("远程已开启", "Remote is on"), ForeColor = Color.Gray, AutoSize = true }, 12);

            var card = new Panel { Width = 320, Height = 320, BackColor = Color.White };
            var pic = new PictureBox { Width = 288, Height = 288, Left = 16, Top = 16, SizeMode = PictureBoxSizeMode.Zoom };
            try
            {
                if (qrPath != null && File.Exists(qrPath))
                    using (var fs = File.OpenRead(qrPath))
                    using (var img = Image.FromStream(fs))
                        pic.Image = new Bitmap(img);
            }
            catch { }
            form.FormClosed += delegate { if (pic.Image != null) { pic.Image.Dispose(); pic.Image = null; } };
            card.Controls.Add(pic);
            addCentered(card, 12);

            addCentered(new Label { Text = I18n.L("扫码链接长期有效，请勿轻易转发", "This link stays valid. Do not forward it casually."), ForeColor = Color.Gray, AutoSize = true }, 8);

            var copyPerm = new Button { Text = MiddleTruncate(LinkForDisplay(url), 44), Width = 340, Height = 32, FlatStyle = FlatStyle.System };
            copyPerm.Click += delegate(object s, EventArgs e) { Clipboard.SetText(url); Flash((Button)s, MiddleTruncate(LinkForDisplay(url), 44)); };
            addCentered(copyPerm, 4);

            addCentered(new Label { Text = I18n.L("点击链接按钮复制到剪贴板", "Click the link button to copy it"), ForeColor = Color.Gray, AutoSize = true }, 16);

            var copyOnce = new Button { Text = I18n.L("复制邀请链接（一次性 · 5 分钟）", "Copy invite link (one-time, 5 min)"), Width = 340, Height = 32, FlatStyle = FlatStyle.System };
            copyOnce.Click += delegate(object s, EventArgs e)
            {
                var r = Backend.Call("pair-once");
                string once = Backend.Str(r, "url");
                if (once == null) { Alert(I18n.L("生成失败", "Create failed"), Backend.Str(r, "error") ?? I18n.L("未知错误", "Unknown error")); return; }
                Clipboard.SetText(once);
                Flash((Button)s, I18n.L("复制邀请链接（一次性 · 5 分钟）", "Copy invite link (one-time, 5 min)"));
            };
            addCentered(copyOnce, 0);

            form.Show();
        }

        void ShowDevices(Dictionary<string, object> res)
        {
            var form = MakeWindow(I18n.L("已配对设备", "Paired devices"), 440, 500);
            var root = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, Padding = new Padding(16), AutoScroll = true };
            form.Controls.Add(root);

            object[] devices = (res != null && res.ContainsKey("devices")) ? res["devices"] as object[] : new object[0];
            if (devices == null || devices.Length == 0)
            {
                root.Controls.Add(new Label { Text = I18n.L("暂无已配对设备", "No paired devices"), ForeColor = Color.Gray, AutoSize = true });
                form.Show();
                return;
            }

            int unused = 0;
            foreach (var od in devices)
            {
                var d = od as Dictionary<string, object>;
                if (d == null) continue;
                string id = Backend.Str(d, "deviceId") ?? "?";
                string id6 = id.Length >= 6 ? id.Substring(0, 6) : id;
                bool viewer = Backend.Str(d, "role") == "viewer";
                string name = Backend.Str(d, "name");
                if (string.IsNullOrEmpty(name)) name = I18n.L("设备 ", "Device ") + id6;
                long lastSeen = Backend.Long(d, "lastSeenAt");
                long createdAt = Backend.Long(d, "createdAt");
                if (!viewer && lastSeen == 0) unused++;

                string title = viewer ? name + I18n.L("（只读）", " (read-only)") : name;
                string sub;
                if (viewer)
                {
                    long exp = Backend.Long(d, "expiresAt");
                    long viewers = Backend.Long(d, "viewers");
                    string expTxt = !Backend.HasKey(d, "expiresAt") ? I18n.L("永久", "permanent") : (exp <= NowMs() ? I18n.L("已过期", "expired") : I18n.L("至 ", "until ") + FmtEpoch(exp));
                    string watch = viewers > 0 ? viewers + I18n.L(" 人正在围观", " viewing") : I18n.L("暂无人围观", "no viewers");
                    sub = expTxt + " · " + watch + " · #" + id6;
                }
                else if (lastSeen > 0) sub = I18n.L("最近连接：", "Last seen: ") + FmtEpoch(lastSeen) + " · #" + id6;
                else if (createdAt > 0) sub = I18n.L("从未连接（配对于 ", "Never connected (paired at ") + FmtEpoch(createdAt) + I18n.L("）", ")") + " · #" + id6;
                else sub = I18n.L("从未连接", "Never connected") + " · #" + id6;

                var rowPanel = new Panel { Width = 390, Height = 48, Margin = new Padding(0, 0, 0, 6) };
                var col = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, Left = 0, Top = 2, Width = 280, Height = 46, WrapContents = false };
                col.Controls.Add(new Label { Text = title, AutoSize = true, Font = FontRowName });
                col.Controls.Add(new Label { Text = sub, AutoSize = true, ForeColor = Color.Gray, Font = FontRowSub });
                rowPanel.Controls.Add(col);

                string devId = id;
                var btn = new Button { Text = viewer ? I18n.L("撤销", "Revoke") : I18n.L("移除", "Remove"), Width = 78, Height = 28, Left = 300, Top = 8, FlatStyle = FlatStyle.System };
                btn.Click += delegate { Backend.Call("revoke", devId); form.Close(); ShowDevices(Backend.Call("devices")); };
                rowPanel.Controls.Add(btn);
                root.Controls.Add(rowPanel);
            }

            if (unused > 0)
            {
                root.Controls.Add(new Label { Text = I18n.L("有 ", "") + unused + I18n.L(" 条从未连接的链接", " unused links"), ForeColor = Color.Gray, AutoSize = true, Margin = new Padding(0, 8, 0, 4) });
                var prune = new Button { Text = I18n.L("清理从未连接的链接（", "Clean unused links (") + unused + I18n.L("）", ")"), Width = 340, Height = 30, FlatStyle = FlatStyle.System };
                prune.Click += delegate
                {
                    var confirm = MessageBox.Show(I18n.L("将作废所有生成过但从未被扫过的链接。已连过的设备不受影响。", "This revokes links that were created but never used. Connected devices are not affected."), I18n.L("清理从未连接的链接", "Clean unused links"), MessageBoxButtons.OKCancel, MessageBoxIcon.Warning);
                    if (confirm != DialogResult.OK) return;
                    var r = Backend.Call("prune-unused");
                    form.Close();
                    ShowDevices(Backend.Call("devices"));
                    Alert(I18n.L("已清理", "Cleaned"), I18n.L("已作废 ", "Revoked ") + Backend.Long(r, "removed") + I18n.L(" 条从未使用的链接。", " unused links."));
                };
                root.Controls.Add(prune);
            }

            form.Show();
        }

        static readonly string[] NotifyTypes = { "bark", "serverchan", "wecom", "dingtalk", "custom" };

        void ShowNotify()
        {
            var form = MakeWindow(I18n.L("通知设置", "Notifications"), 440, 500);
            var root = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, Padding = new Padding(16), AutoScroll = true };
            form.Controls.Add(root);

            root.Controls.Add(new Label { Text = I18n.L("添加通知渠道", "Add channel"), Font = FontSection, AutoSize = true, Margin = new Padding(0, 0, 0, 6) });
            var combo = new ComboBox { Width = 360, DropDownStyle = ComboBoxStyle.DropDownList };
            combo.Items.AddRange(new object[] { "Bark", "Server酱", "企业微信", "钉钉", I18n.L("自定义", "Custom") });
            combo.SelectedIndex = 0;
            root.Controls.Add(combo);
            var field = new TextBox { Width = 360, Margin = new Padding(0, 6, 0, 6) };
            root.Controls.Add(field);
            root.Controls.Add(new Label { Text = I18n.L("Bark/Server酱 填 Key；其余填 Webhook URL", "Bark/ServerChan use Key; others use Webhook URL"), ForeColor = Color.Gray, AutoSize = true, Margin = new Padding(0, 0, 0, 6) });

            var btnRow = new FlowLayoutPanel { FlowDirection = FlowDirection.LeftToRight, Width = 360, Height = 36, WrapContents = false };
            var addBtn = new Button { Text = I18n.L("添加", "Add"), Width = 90, Height = 28, FlatStyle = FlatStyle.System };
            var testBtn = new Button { Text = I18n.L("发送测试", "Test"), Width = 100, Height = 28, FlatStyle = FlatStyle.System };
            btnRow.Controls.Add(addBtn);
            btnRow.Controls.Add(testBtn);
            root.Controls.Add(btnRow);

            addBtn.Click += delegate
            {
                string json = NotifyJson(combo.SelectedIndex, field.Text.Trim());
                if (json == null) { Alert(I18n.L("请填写", "Missing input"), I18n.L("请填入 Key 或 Webhook URL", "Enter a Key or Webhook URL")); return; }
                Backend.CallWithInput("notify-add", json);
                form.Close();
                ShowNotify();
            };
            testBtn.Click += delegate
            {
                string json = NotifyJson(combo.SelectedIndex, field.Text.Trim());
                if (json == null) { Alert(I18n.L("请填写", "Missing input"), I18n.L("请填入 Key 或 Webhook URL", "Enter a Key or Webhook URL")); return; }
                var r = Backend.CallWithInput("notify-test", json);
                Alert(I18n.L("已发送", "Sent"), I18n.L("已向 ", "Sent to ") + Backend.Long(r, "count") + I18n.L(" 个渠道发送测试通知。", " channel(s)."));
            };

            root.Controls.Add(new Label { Text = I18n.L("已配置：", "Configured:"), AutoSize = true, Margin = new Padding(0, 10, 0, 4) });
            var list = Backend.Call("notify-list");
            object[] notifiers = (list != null && list.ContainsKey("notifiers")) ? list["notifiers"] as object[] : new object[0];
            foreach (var on in notifiers ?? new object[0])
            {
                var n = on as Dictionary<string, object>;
                if (n == null) continue;
                long idx = Backend.Long(n, "index");
                string label = Backend.Str(n, "label") ?? "";
                var rowPanel = new Panel { Width = 390, Height = 34 };
                rowPanel.Controls.Add(new Label { Text = label, AutoSize = true, Left = 0, Top = 7, Width = 210 });
                long capIdx = idx;
                var test = new Button { Text = I18n.L("测试", "Test"), Width = 64, Height = 26, Left = 245, Top = 2, FlatStyle = FlatStyle.System };
                test.Click += delegate
                {
                    var r = Backend.Call("notify-test-index", capIdx.ToString());
                    Alert(I18n.L("已发送", "Sent"), I18n.L("已向 ", "Sent to ") + Backend.Long(r, "count") + I18n.L(" 个渠道发送测试通知。", " channel(s)."));
                };
                rowPanel.Controls.Add(test);
                var del = new Button { Text = I18n.L("删除", "Remove"), Width = 70, Height = 26, Left = 315, Top = 2, FlatStyle = FlatStyle.System };
                del.Click += delegate { Backend.Call("notify-remove", capIdx.ToString()); form.Close(); ShowNotify(); };
                rowPanel.Controls.Add(del);
                root.Controls.Add(rowPanel);
            }

            form.Show();
        }

        static string NotifyJson(int selectedIndex, string value)
        {
            if (string.IsNullOrEmpty(value)) return null;
            string type = NotifyTypes[selectedIndex];
            if (type == "bark" || type == "serverchan")
                return "{\"type\":\"" + type + "\",\"key\":\"" + JsonEsc(value) + "\"}";
            return "{\"type\":\"" + type + "\",\"url\":\"" + JsonEsc(value) + "\"}";
        }

        Form MakeWindow(string title, int w, int h)
        {
            var form = new Form
            {
                Text = title,
                Width = w,
                Height = h,
                StartPosition = FormStartPosition.CenterScreen,
                FormBorderStyle = FormBorderStyle.FixedDialog,
                MaximizeBox = false,
                MinimizeBox = false,
                ShowInTaskbar = true,
                Font = FontBase,
            };
            windows.Add(form);
            form.FormClosed += delegate { windows.Remove(form); };
            form.TopMost = true;
            return form;
        }

        void Alert(string title, string message)
        {
            MessageBox.Show(message ?? "", title, MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        static void Flash(Button b, string restore)
        {
            b.Text = I18n.L("已复制", "Copied");
            b.Enabled = false;
            var t = new System.Windows.Forms.Timer { Interval = 1200 };
            t.Tick += delegate { b.Text = restore; b.Enabled = true; t.Stop(); t.Dispose(); };
            t.Start();
        }

        static long NowMs() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds; }

        static string FmtEpoch(long ms)
        {
            if (ms <= 0) return "";
            var dt = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(ms).ToLocalTime();
            return dt.ToString("MM-dd HH:mm");
        }

        static string LinkForDisplay(string url)
        {
            int i = url.IndexOf("github.io");
            if (i >= 0) return url.Substring(i);
            return url.Replace("https://", "").Replace("http://", "");
        }

        static string MiddleTruncate(string s, int max)
        {
            if (s.Length <= max) return s;
            int head = (max - 1) / 2;
            int tail = max - 1 - head;
            return s.Substring(0, head) + "..." + s.Substring(s.Length - tail);
        }

        static string JsonEsc(string s)
        {
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n");
        }
    }
}
