package com.driftgirlsreborn.app;

import android.app.ActivityManager;
import android.app.ApplicationExitInfo;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.opengl.EGL14;
import android.opengl.EGLConfig;
import android.opengl.EGLContext;
import android.opengl.EGLDisplay;
import android.opengl.EGLSurface;
import android.opengl.GLES20;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.webkit.WebView;
import android.widget.Toast;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Diagnostic export (diag build only).
 *
 * At each start, if the app ended abnormally since the last export (native crash, Java crash, ANR, low memory,
 * excessive resource usage, freezer) or the WebView renderer was lost, writes one JSON file to the public
 * Download/DriftGirlsDiag folder (MediaStore, no permission needed on Android 10+). The very first start of this
 * build always writes one, so the user can check that the export works.
 *
 * The file holds: the device (SoC, GPU renderer string, Android, WebView version), the recent exit reasons with
 * their raw traces (native tombstone protobuf / ANR text, base64), the shell's own events.json, and this app's
 * logcat. Every failure here is swallowed: the export must never stop the game from starting.
 */
final class DiagExport {
    private static final String TAG = "DriftGirls";
    private static final int TRACE_MAX = 1 << 20;
    private static final int LOGCAT_MAX = 3 << 20;

    private DiagExport() {
    }

    static void run(Context ctx) {
        try {
            run0(ctx.getApplicationContext());
        } catch (Throwable t) {
            Log.w(TAG, "diag export failed", t);
        }
    }

    private static boolean abnormal(int reason) {
        // 3 low_memory, 4 crash, 5 crash_native, 6 anr, 7 init failure, 9 excessive resource, 14 freezer
        return reason == 3 || reason == 4 || reason == 5 || reason == 6 || reason == 7 || reason == 9 || reason == 14;
    }

    private static void run0(final Context ctx) throws Exception {
        SharedPreferences prefs = ctx.getSharedPreferences("diagexport", 0);
        long lastExit = prefs.getLong("lastExit", 0);
        long lastEvents = prefs.getLong("lastEvents", 0);
        boolean first = !prefs.getBoolean("done", false);

        File events = new File(new File(ctx.getFilesDir(), "diag"), "events.json");
        String eventsText = events.isFile() ? readFile(events, 2 << 20) : null;
        boolean newRendererLoss = events.isFile() && events.lastModified() > lastEvents && eventsText != null
                && (eventsText.contains("renderer_gone") || eventsText.contains("recovery_loop")
                || eventsText.contains("renderer_unresponsive"));

        JSONArray exits = new JSONArray();
        long newest = lastExit;
        boolean newAbnormal = false;
        if (Build.VERSION.SDK_INT >= 30) {
            ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
            List<ApplicationExitInfo> list = am.getHistoricalProcessExitReasons(null, 0, 16);
            for (ApplicationExitInfo e : list) {
                long ts = e.getTimestamp();
                boolean isNew = ts > lastExit;
                if (isNew && abnormal(e.getReason())) newAbnormal = true;
                if (ts > newest) newest = ts;
                JSONObject o = new JSONObject();
                o.put("time", iso(ts)).put("ts", ts).put("new", isNew)
                        .put("reason", e.getReason()).put("reasonName", Diag.exitReason(e.getReason()))
                        .put("status", e.getStatus()).put("importance", e.getImportance())
                        .put("process", e.getProcessName()).put("pid", e.getPid())
                        .put("description", String.valueOf(e.getDescription()))
                        .put("pssKb", e.getPss()).put("rssKb", e.getRss());
                int r = e.getReason();
                if (isNew && (r == 4 || r == 5 || r == 6)) {
                    try {
                        InputStream in = e.getTraceInputStream();
                        if (in != null) {
                            byte[] b = readAll(in, TRACE_MAX);
                            o.put("traceKind", r == 5 ? "tombstone_protobuf" : "text");
                            o.put("traceBytes", b.length);
                            o.put("traceBase64", Base64.encodeToString(b, Base64.NO_WRAP));
                        }
                    } catch (Throwable t) {
                        o.put("traceError", String.valueOf(t));
                    }
                }
                exits.put(o);
            }
        }

        if (!first && !newAbnormal && !newRendererLoss) return;

        JSONObject out = new JSONObject();
        out.put("format", "dg-diag-export/1");
        out.put("exported", iso(System.currentTimeMillis()));
        out.put("trigger", first ? "first_start" : newAbnormal ? "abnormal_exit" : "renderer_lost");
        out.put("app", app(ctx));
        out.put("device", device());
        out.put("gpu", gpu());
        out.put("exits", exits);
        out.put("events", eventsText == null ? JSONObject.NULL : eventsText);
        out.put("logcat", logcat());

        String name = "DriftGirls-diag-" + new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.ROOT).format(new Date()) + ".json";
        String where = write(ctx, name, out.toString(1).getBytes(StandardCharsets.UTF_8));

        SharedPreferences.Editor ed = prefs.edit().putBoolean("done", true).putLong("lastExit", newest);
        if (events.isFile()) ed.putLong("lastEvents", events.lastModified());
        ed.apply();

        final String msg = "Diagnostic saved: " + where;
        Log.i(TAG, msg);
        new Handler(Looper.getMainLooper()).post(new Runnable() {
            @Override
            public void run() {
                try {
                    Toast.makeText(ctx, msg, Toast.LENGTH_LONG).show();
                } catch (Throwable ignored) {
                }
            }
        });
    }

    private static JSONObject app(Context ctx) throws Exception {
        JSONObject o = new JSONObject();
        PackageInfo pi = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
        o.put("package", ctx.getPackageName()).put("versionName", pi.versionName)
                .put("versionCode", Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode)
                .put("diagBuild", true);
        if (Build.VERSION.SDK_INT >= 26) {
            PackageInfo wv = WebView.getCurrentWebViewPackage();
            if (wv != null) o.put("webview", wv.packageName + " " + wv.versionName);
        }
        ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
        ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
        am.getMemoryInfo(mi);
        o.put("totalMemMb", mi.totalMem >> 20).put("availMemMb", mi.availMem >> 20)
                .put("lowRamDevice", am.isLowRamDevice()).put("memoryClassMb", am.getMemoryClass())
                .put("largeMemoryClassMb", am.getLargeMemoryClass());
        return o;
    }

    private static JSONObject device() throws Exception {
        JSONObject o = new JSONObject();
        o.put("manufacturer", Build.MANUFACTURER).put("brand", Build.BRAND).put("model", Build.MODEL)
                .put("device", Build.DEVICE).put("board", Build.BOARD).put("hardware", Build.HARDWARE)
                .put("release", Build.VERSION.RELEASE).put("sdk", Build.VERSION.SDK_INT)
                .put("securityPatch", Build.VERSION.SECURITY_PATCH).put("fingerprint", Build.FINGERPRINT)
                .put("abis", new JSONArray(Build.SUPPORTED_ABIS));
        if (Build.VERSION.SDK_INT >= 31) {
            o.put("socManufacturer", Build.SOC_MANUFACTURER).put("socModel", Build.SOC_MODEL);
        }
        return o;
    }

    /** GL_RENDERER / GL_VENDOR / GL_VERSION from a throwaway 1x1 pbuffer context (ES 3, else ES 2). */
    private static JSONObject gpu() {
        JSONObject o = new JSONObject();
        EGLDisplay dpy = EGL14.EGL_NO_DISPLAY;
        EGLContext c = EGL14.EGL_NO_CONTEXT;
        EGLSurface s = EGL14.EGL_NO_SURFACE;
        try {
            dpy = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);
            int[] ver = new int[2];
            if (!EGL14.eglInitialize(dpy, ver, 0, ver, 1)) throw new IllegalStateException("eglInitialize");
            int[] attrs = {EGL14.EGL_RENDERABLE_TYPE, 0x40 /* EGL_OPENGL_ES3_BIT */, EGL14.EGL_SURFACE_TYPE,
                    EGL14.EGL_PBUFFER_BIT, EGL14.EGL_NONE};
            EGLConfig[] cfg = new EGLConfig[1];
            int[] n = new int[1];
            int es = 3;
            if (!EGL14.eglChooseConfig(dpy, attrs, 0, cfg, 0, 1, n, 0) || n[0] == 0) {
                attrs[1] = EGL14.EGL_OPENGL_ES2_BIT;
                es = 2;
                EGL14.eglChooseConfig(dpy, attrs, 0, cfg, 0, 1, n, 0);
            }
            c = EGL14.eglCreateContext(dpy, cfg[0], EGL14.EGL_NO_CONTEXT,
                    new int[]{EGL14.EGL_CONTEXT_CLIENT_VERSION, es, EGL14.EGL_NONE}, 0);
            s = EGL14.eglCreatePbufferSurface(dpy, cfg[0], new int[]{EGL14.EGL_WIDTH, 1, EGL14.EGL_HEIGHT, 1, EGL14.EGL_NONE}, 0);
            EGL14.eglMakeCurrent(dpy, s, s, c);
            o.put("renderer", GLES20.glGetString(GLES20.GL_RENDERER))
                    .put("vendor", GLES20.glGetString(GLES20.GL_VENDOR))
                    .put("version", GLES20.glGetString(GLES20.GL_VERSION))
                    .put("egl", EGL14.eglQueryString(dpy, EGL14.EGL_VERSION));
        } catch (Throwable t) {
            try {
                o.put("error", String.valueOf(t));
            } catch (Throwable ignored) {
            }
        } finally {
            try {
                if (dpy != EGL14.EGL_NO_DISPLAY) {
                    EGL14.eglMakeCurrent(dpy, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT);
                    if (s != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(dpy, s);
                    if (c != EGL14.EGL_NO_CONTEXT) EGL14.eglDestroyContext(dpy, c);
                    EGL14.eglReleaseThread();
                }
            } catch (Throwable ignored) {
            }
        }
        return o;
    }

    /** This app's own log lines (an app may read its own): main, system and crash buffers. */
    private static String logcat() {
        try {
            Process p = new ProcessBuilder("logcat", "-d", "-v", "threadtime", "-b", "main,system,crash", "-t", "6000")
                    .redirectErrorStream(true).start();
            byte[] b = readAll(p.getInputStream(), LOGCAT_MAX);
            p.destroy();
            return new String(b, StandardCharsets.UTF_8);
        } catch (Throwable t) {
            return "logcat failed: " + t;
        }
    }

    private static String write(Context ctx, String name, byte[] data) throws Exception {
        if (Build.VERSION.SDK_INT >= 29) {
            ContentResolver cr = ctx.getContentResolver();
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, "application/json");
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, "Download/DriftGirlsDiag");
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (uri == null) throw new IllegalStateException("MediaStore insert");
            try (OutputStream os = cr.openOutputStream(uri)) {
                if (os == null) throw new IllegalStateException("MediaStore open");
                os.write(data);
            }
            v.clear();
            v.put(MediaStore.MediaColumns.IS_PENDING, 0);
            cr.update(uri, v, null, null);
            return "Download/DriftGirlsDiag/" + name;
        }
        File dir = new File(ctx.getExternalFilesDir(null), "DriftGirlsDiag");
        dir.mkdirs();
        File f = new File(dir, name);
        try (FileOutputStream os = new FileOutputStream(f)) {
            os.write(data);
        }
        return f.getPath();
    }

    private static String iso(long ms) {
        return new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSZ", Locale.ROOT).format(new Date(ms));
    }

    private static String readFile(File f, int max) {
        try (InputStream in = new FileInputStream(f)) {
            return new String(readAll(in, max), StandardCharsets.UTF_8);
        } catch (Throwable t) {
            return null;
        }
    }

    private static byte[] readAll(InputStream in, int max) throws Exception {
        try {
            ByteArrayOutputStream bo = new ByteArrayOutputStream(65536);
            byte[] buf = new byte[65536];
            int n;
            while (bo.size() < max && (n = in.read(buf, 0, Math.min(buf.length, max - bo.size()))) > 0) {
                bo.write(buf, 0, n);
            }
            return bo.toByteArray();
        } finally {
            in.close();
        }
    }
}
