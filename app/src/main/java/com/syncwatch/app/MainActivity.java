package com.syncwatch.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * SyncWatch for Android.
 * Three WebViews: the Cinemana page (content), the toolbar/lobby (uiView, same HTML as the Windows app),
 * and the chat bubble (chatView). Native code only moves messages between them and resizes them.
 */
public class MainActivity extends Activity {
    private static final String SITE_HOST = "cinemana.shabakaty.com";
    private static final String HOME = "https://cinemana.shabakaty.com/";
    private static final String ASSET_ORIGIN = "https://appassets.androidplatform.net/assets/";
    private static final int REQ_MIC = 7;
    private static final Pattern EPISODE = Pattern.compile("^/video/[a-z]{2}/\\d+");
    private static final Pattern AUTH = Pattern.compile("/(login|signin|sign-in|register|signup|sign-up|auth|account|password|logout)(/|$)", Pattern.CASE_INSENSITIVE);

    private final Handler h = new Handler(Looper.getMainLooper());
    private FrameLayout root, fullscreenHolder;
    private LinearLayout column;
    private WebView uiView, content, chatView;
    private SharedPreferences prefs;
    private boolean chatOpen = false, panelOpen = true;
    private String lastKey = null, remoteKey = null;
    private String lastCfg = "{\"isMain\":false,\"connected\":false,\"lag\":0}";
    private volatile String currentHost = "";
    private String injectScript = "";
    private View customView;
    private WebChromeClient.CustomViewCallback customCb;
    private PermissionRequest pendingPerm;

    // ------------------------------------------------------------------ small helpers
    private int dp(int v) { return (int) (v * getResources().getDisplayMetrics().density + 0.5f); }

    private String readAsset(String name) {
        try (InputStream in = getAssets().open(name)) {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            return bo.toString("UTF-8");
        } catch (Exception e) {
            return "";
        }
    }

    /** A JSON value like "abc" or true, as plain text. */
    private String str(String json) {
        try {
            Object o = new JSONTokener(json).nextValue();
            return o == null ? "" : String.valueOf(o);
        } catch (Exception e) {
            return "";
        }
    }

    private static boolean siteHost(String host) {
        return host != null && (host.equals(SITE_HOST) || host.equals("shabakaty.com") || host.endsWith(".shabakaty.com"));
    }

    private boolean shareable(String url) {
        if (url == null) return false;
        Uri u = Uri.parse(url);
        String s = u.getScheme();
        if (!("http".equals(s) || "https".equals(s))) return false;
        if (!siteHost(u.getHost())) return false;
        String p = u.getPath() == null ? "" : u.getPath();
        return !AUTH.matcher(p).find();
    }

    /** Two URLs are "the same page" when this key matches (episode pages ignore the query string). */
    private String keyOf(String url) {
        if (url == null) return "";
        Uri u = Uri.parse(url);
        String p = u.getPath() == null ? "" : u.getPath();
        String origin = u.getScheme() + "://" + u.getAuthority();
        if (EPISODE.matcher(p).find()) return origin + p;
        return origin + p + (u.getQuery() != null ? "?" + u.getQuery() : "");
    }

    private String normalizeUrl(String u) {
        u = u == null ? "" : u.trim();
        if (u.isEmpty()) return null;
        if (!u.matches("(?i)^[a-z][a-z0-9+.-]*://.*")) u = "https://" + u;
        String s = Uri.parse(u).getScheme();
        return ("http".equalsIgnoreCase(s) || "https".equalsIgnoreCase(s)) ? u : null;
    }

    private String settingsJson() {
        try {
            JSONObject d = new JSONObject(readAsset("defaults.json"));
            JSONObject s = new JSONObject(prefs.getString("settings", "{}"));
            Iterator<String> it = s.keys();
            while (it.hasNext()) {
                String k = it.next();
                d.put(k, s.get(k));
            }
            return d.toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    // ------------------------------------------------------------------ delivering messages into a WebView
    private void deliver(final WebView wv, final String fn, String channel, String json) {
        final String js = "try{" + fn + "(" + JSONObject.quote(channel) + "," + JSONObject.quote(json == null ? "null" : json) + ")}catch(e){}";
        h.post(new Runnable() { public void run() { wv.evaluateJavascript(js, null); } });
    }
    private void toUi(String ch, String json) { deliver(uiView, "window.__deliver", ch, json); }
    private void toChat(String ch, String json) { deliver(chatView, "window.__deliver", ch, json); }
    private void toContent(String ch, String json) { deliver(content, "window.__syncDeliver", ch, json); }

    // ------------------------------------------------------------------ lifecycle
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        prefs = getSharedPreferences("syncwatch", MODE_PRIVATE);
        WebView.setWebContentsDebuggingEnabled(true); // lets us debug with chrome://inspect when something goes wrong
        injectScript = readAsset("page-inject.js");

        root = new FrameLayout(this);
        root.setBackgroundColor(0xFF111114);
        column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        uiView = new WebView(this);
        content = new WebView(this);
        chatView = new WebView(this);
        column.addView(uiView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52)));
        column.addView(content, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        root.addView(column, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(chatView, new FrameLayout.LayoutParams(dp(64), dp(64)));
        fullscreenHolder = new FrameLayout(this);
        fullscreenHolder.setBackgroundColor(Color.BLACK);
        fullscreenHolder.setVisibility(View.GONE);
        root.addView(fullscreenHolder, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        setupUi();
        setupChat();
        setupContent();
        setBrowseMode(false);
        layoutChat();
        h.postDelayed(poller, 800);
    }

    @Override
    protected void onDestroy() {
        h.removeCallbacksAndMessages(null);
        for (WebView w : new WebView[]{uiView, content, chatView}) {
            if (w != null) { w.stopLoading(); w.destroy(); }
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (customView != null) { hideCustom(); return; }
        if (panelOpen) { uiView.evaluateJavascript("try{showPanel(null)}catch(e){}", null); return; }
        if (chatOpen) { chatView.evaluateJavascript("try{document.querySelector('#close').click()}catch(e){}", null); return; }
        if (content.canGoBack()) { content.goBack(); return; }
        super.onBackPressed();
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
        super.onRequestPermissionsResult(code, perms, res);
        if (code != REQ_MIC || pendingPerm == null) return;
        if (res.length > 0 && res[0] == PackageManager.PERMISSION_GRANTED) pendingPerm.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        else { pendingPerm.deny(); Toast.makeText(this, "Microphone permission was denied. Allow it in Android Settings > Apps > SyncWatch.", Toast.LENGTH_LONG).show(); }
        pendingPerm = null;
    }

    // ------------------------------------------------------------------ layout
    /** browsing = toolbar + page; otherwise the toolbar WebView fills the screen (lobby / audio panels). */
    private void setBrowseMode(boolean browsing) {
        panelOpen = !browsing;
        LinearLayout.LayoutParams lp = (LinearLayout.LayoutParams) uiView.getLayoutParams();
        if (browsing) { lp.height = dp(52); lp.weight = 0f; } else { lp.height = 0; lp.weight = 1f; }
        uiView.setLayoutParams(lp);
        content.setVisibility(browsing ? View.VISIBLE : View.GONE);
        chatView.setVisibility(browsing ? View.VISIBLE : View.GONE);
    }

    private void layoutChat() {
        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) chatView.getLayoutParams();
        DisplayMetrics dm = getResources().getDisplayMetrics();
        if (chatOpen) {
            lp.width = Math.min(dp(360), dm.widthPixels - dp(24));
            lp.height = Math.min(dp(480), (int) (dm.heightPixels * 0.62f));
        } else {
            lp.width = dp(64);
            lp.height = dp(64);
        }
        lp.gravity = Gravity.BOTTOM | Gravity.END;
        lp.setMargins(0, 0, dp(12), dp(12));
        chatView.setLayoutParams(lp);
    }

    private void setImmersiveMode(boolean on) {
        View d = getWindow().getDecorView();
        d.setSystemUiVisibility(on ? (View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN) : View.SYSTEM_UI_FLAG_VISIBLE);
    }

    private void hideCustom() {
        if (customView == null) return;
        fullscreenHolder.removeView(customView);
        fullscreenHolder.setVisibility(View.GONE);
        customView = null;
        if (customCb != null) customCb.onCustomViewHidden();
        customCb = null;
        setImmersiveMode(false);
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
    }

    // ------------------------------------------------------------------ WebViews
    private WebViewClient assetClient() {
        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this)).build();
        return new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                return loader.shouldInterceptRequest(r.getUrl());
            }
        };
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void setupUi() {
        WebSettings s = uiView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        uiView.setBackgroundColor(Color.TRANSPARENT);
        uiView.addJavascriptInterface(new UiBridge(), "AndroidUI");
        uiView.setWebViewClient(assetClient());
        uiView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest req) {
                runOnUiThread(new Runnable() {
                    public void run() {
                        boolean audio = false;
                        for (String r : req.getResources()) if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) audio = true;
                        if (!audio) { req.deny(); return; }
                        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                            req.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                        } else {
                            pendingPerm = req;
                            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
                        }
                    }
                });
            }
        });
        uiView.loadUrl(ASSET_ORIGIN + "ui.html");
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void setupChat() {
        WebSettings s = chatView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // chat history lives in this storage, on this phone only
        chatView.setBackgroundColor(Color.TRANSPARENT);
        chatView.addJavascriptInterface(new ChatBridge(), "AndroidChat");
        chatView.setWebViewClient(assetClient());
        chatView.loadUrl(ASSET_ORIGIN + "chat.html");
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void setupContent() {
        WebSettings s = content.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setUserAgentString(s.getUserAgentString().replace("; wv", "")); // look like normal Chrome
        content.setBackgroundColor(Color.BLACK);
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(content, true);
        content.addJavascriptInterface(new PageBridge(), "SyncPage");

        // Inject the sync script as early as possible, only on Cinemana pages
        try {
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                Set<String> rules = new HashSet<String>();
                rules.add("https://*.shabakaty.com");
                rules.add("https://shabakaty.com");
                WebViewCompat.addDocumentStartJavaScript(content, injectScript, rules);
            }
        } catch (Exception e) { /* the onPageFinished injection below is the fallback */ }

        content.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView v, String url, Bitmap fav) {
                currentHost = Uri.parse(url).getHost();
                sendNav();
                onUrl(url);
            }
            @Override
            public void onPageFinished(WebView v, String url) {
                currentHost = Uri.parse(url).getHost();
                if (siteHost(currentHost)) v.evaluateJavascript(injectScript, null); // guarded inside: runs once per page
                sendNav();
                onUrl(url);
            }
            @Override
            public void doUpdateVisitedHistory(WebView v, String url, boolean isReload) {
                sendNav();
                onUrl(url);
            }
            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView v, String url) {
                String sc = Uri.parse(url).getScheme();
                return !("http".equals(sc) || "https".equals(sc)); // never open other apps from the page
            }
        });
        content.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onReceivedTitle(WebView v, String t) { sendNav(); }
            @Override
            public Bitmap getDefaultVideoPoster() { return Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888); }
            @Override
            public void onPermissionRequest(PermissionRequest req) { req.deny(); }
            @Override
            public void onShowCustomView(View view, CustomViewCallback cb) {
                if (customView != null) { cb.onCustomViewHidden(); return; }
                customView = view;
                customCb = cb;
                fullscreenHolder.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                fullscreenHolder.setVisibility(View.VISIBLE);
                setImmersiveMode(true);
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
            }
            @Override
            public void onHideCustomView() { hideCustom(); }
        });
        content.loadUrl(HOME);
    }

    // ------------------------------------------------------------------ navigation + link sync
    private void sendNav() {
        try {
            JSONObject o = new JSONObject();
            String url = content.getUrl();
            o.put("url", url == null ? "" : url);
            o.put("title", content.getTitle() == null ? "" : content.getTitle());
            o.put("canGoBack", content.canGoBack());
            o.put("canGoForward", content.canGoForward());
            toUi("nav:state", o.toString());
        } catch (Exception e) { /* ignore */ }
    }

    /** Called for every URL change (callbacks + a poll as a safety net for single-page routes). */
    private void onUrl(String url) {
        if (url == null || !shareable(url)) return;
        String k = keyOf(url);
        if (k.isEmpty() || k.equals(lastKey)) return;
        lastKey = k;
        if (remoteKey != null && remoteKey.equals(k)) { remoteKey = null; return; } // we caused this one: do not echo
        try {
            Uri u = Uri.parse(url);
            String clean = u.getScheme() + "://" + u.getAuthority() + (u.getPath() == null ? "" : u.getPath()) + (u.getQuery() != null ? "?" + u.getQuery() : "");
            JSONObject o = new JSONObject();
            o.put("url", clean);
            toUi("nav:changed", o.toString());
        } catch (Exception e) { /* ignore */ }
    }

    private final Runnable poller = new Runnable() {
        public void run() {
            try { onUrl(content.getUrl()); } catch (Exception e) { /* ignore */ }
            h.postDelayed(this, 800);
        }
    };

    private void openRemote(String url) {
        if (!shareable(url)) return;
        final String k = keyOf(url);
        if (k.equals(keyOf(content.getUrl()))) return;
        remoteKey = k;
        h.postDelayed(new Runnable() { public void run() { if (k.equals(remoteKey)) remoteKey = null; } }, 10000);
        content.loadUrl(url);
    }

    // ------------------------------------------------------------------ bridges (JavaScript -> Java)
    private class UiBridge {
        @JavascriptInterface
        public String getSettings() { return settingsJson(); }

        @JavascriptInterface
        public void setSettings(String json) {
            try {
                JSONObject o = new JSONObject(json);
                o.remove("auto");
                prefs.edit().putString("settings", o.toString()).apply();
            } catch (Exception e) { /* ignore */ }
        }

        @JavascriptInterface
        public void send(final String channel, final String json) {
            final String v = str(json);
            h.post(new Runnable() {
                public void run() {
                    switch (channel) {
                        case "view:show": setBrowseMode("true".equals(v)); break;
                        case "nav:go": { String u = normalizeUrl(v); if (u != null) content.loadUrl(u); break; }
                        case "nav:cmd":
                            if ("back".equals(v) && content.canGoBack()) content.goBack();
                            else if ("forward".equals(v) && content.canGoForward()) content.goForward();
                            else if ("reload".equals(v)) content.reload();
                            else if ("home".equals(v)) content.loadUrl(HOME);
                            break;
                        case "nav:remote": openRemote(v); break;
                        case "sync:in": toContent("sync:in", json); break;
                        case "sync:config": lastCfg = json; toContent("sync:config", json); break;
                        case "chat:in": toChat("chat:in", json); break;
                        case "toast": Toast.makeText(MainActivity.this, v, Toast.LENGTH_LONG).show(); break;
                        default: break;
                    }
                }
            });
        }
    }

    private class ChatBridge {
        @JavascriptInterface
        public void send(final String channel, final String json) {
            if ("chat:send".equals(channel)) {
                toUi("chat:send", json);
            } else if ("chat:size".equals(channel)) {
                final boolean open = "true".equals(str(json));
                h.post(new Runnable() { public void run() { chatOpen = open; layoutChat(); } });
            }
        }
    }

    private class PageBridge {
        @JavascriptInterface
        public void send(String channel, String json) {
            if (!siteHost(currentHost)) return; // only Cinemana pages may talk to the app
            if ("sync:out".equals(channel)) toUi("sync:out", json);
            else if ("video:status".equals(channel)) toUi("video:status", json);
            else if ("page:ready".equals(channel)) toContent("sync:config", lastCfg);
        }
    }
}
