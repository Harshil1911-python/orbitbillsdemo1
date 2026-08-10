(function(){
  if(window.__orbitNativeLoaded) return;
  window.__orbitNativeLoaded = true;
  function hasCap(){ return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()); }
  function plugin(n){ try{ return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins[n]; }catch(e){ return null; } }
  async function setChromeColors(){
    var brand = "#0b3d91";
    try{
      var StatusBar=plugin("StatusBar");
      if(StatusBar){
        if(StatusBar.setBackgroundColor) await StatusBar.setBackgroundColor({color:brand});
        if(StatusBar.setStyle) await StatusBar.setStyle({style:"LIGHT"});
        if(StatusBar.setOverlaysWebView) await StatusBar.setOverlaysWebView({overlay:false});
      }
    }catch(e){}
    // Android system navigation bar (Back / Home / Recents) — match cart bar blue
    try{
      var Nav = plugin("NavigationBar") || plugin("EdgeToEdge") || plugin("AndroidNavigationBar");
      if(Nav){
        if(Nav.setColor) await Nav.setColor({ color: brand, darkButtons: false });
        else if(Nav.setBackgroundColor) await Nav.setBackgroundColor({ color: brand });
        else if(Nav.setNavigationBarColor) await Nav.setNavigationBarColor({ color: brand });
      }
    }catch(e){}
    try{
      // Capawesome / community edge-to-edge helpers
      var E = plugin("EdgeToEdge");
      if(E && E.setBackgroundColor) await E.setBackgroundColor({ color: brand });
    }catch(e){}
    // Web fallback: paint under the system gesture/nav area
    try{
      var meta = document.querySelector('meta[name="theme-color"]');
      if(meta) meta.setAttribute("content", brand);
      else {
        meta = document.createElement("meta");
        meta.name = "theme-color";
        meta.content = brand;
        document.head.appendChild(meta);
      }
      ensureNavFill(brand);
    }catch(e){}
  }
  function ensureNavFill(brand){
    if(document.getElementById("orbitNavFill")) return;
    var fill = document.createElement("div");
    fill.id = "orbitNavFill";
    fill.setAttribute("aria-hidden","true");
    fill.style.cssText = "position:fixed;left:0;right:0;bottom:0;height:env(safe-area-inset-bottom,0px);min-height:0;background:"+(brand||"#0b3d91")+";z-index:99998;pointer-events:none;";
    (document.body||document.documentElement).appendChild(fill);
  }
  async function ready(){
    if(!hasCap()){ setupNetwork(); setupBackButton(); try{ ensureNavFill("#0b3d91"); }catch(e){} return false; }
    await setChromeColors();
    try{ var Splash=plugin("SplashScreen"); if(Splash&&Splash.hide) await Splash.hide({fadeOutDuration:250}); }catch(e){}
    try{ var Keyboard=plugin("Keyboard"); if(Keyboard&&Keyboard.setResizeMode) await Keyboard.setResizeMode({mode:"body"}); }catch(e){}
    setupNetwork(); setupBackButton();
    try{ if(/billing\.html/i.test(location.pathname||"") && navigator.wakeLock && navigator.wakeLock.request){ try{ window.__orbitWake=await navigator.wakeLock.request("screen"); }catch(e){} } }catch(e){}
    return true;
  }
  function setupNetwork(){
    var Network=plugin("Network");
    var bar=document.getElementById("orbitOfflineBanner");
    if(!bar){ bar=document.createElement("div"); bar.id="orbitOfflineBanner"; bar.style.cssText="display:none;position:fixed;left:0;right:0;top:0;z-index:99999;background:#b91c1c;color:#fff;text-align:center;font:600 13px/1.3 system-ui,sans-serif;padding:8px 10px;padding-top:max(8px,env(safe-area-inset-top));"; bar.textContent="You are offline — sales stay on this device until sync returns"; (document.body||document.documentElement).appendChild(bar); }
    function setOnline(ok){ bar.style.display=ok?"none":"block"; }
    if(Network&&Network.getStatus){ Network.getStatus().then(function(s){ setOnline(!!s.connected); }).catch(function(){}); if(Network.addListener) Network.addListener("networkStatusChange", function(s){ setOnline(!!s.connected); }); }
    else { setOnline(navigator.onLine); window.addEventListener("online", function(){ setOnline(true); }); window.addEventListener("offline", function(){ setOnline(false); }); }
  }
  function setupBackButton(){
    var App=plugin("App");
    window.__orbitAndroidBack=function(){
      if(document.body&&document.body.classList.contains("m-cart-open")){ if(window.__orbitCloseMobileCart) window.__orbitCloseMobileCart(); else document.body.classList.remove("m-cart-open"); return true; }
      var menu=document.getElementById("mobileMenu");
      if(menu&&menu.classList.contains("open")){ if(window.__orbitCloseMobileMenu) window.__orbitCloseMobileMenu(); else menu.classList.remove("open"); return true; }
      var openModal=document.querySelector(".modal-bg.open");
      if(openModal){ openModal.classList.remove("open"); return true; }
      if(window.history.length>1){ history.back(); return true; }
      return false;
    };
    if(App&&App.addListener){ App.addListener("backButton", function(){ var handled=false; try{ handled=!!window.__orbitAndroidBack(); }catch(e){} if(!handled&&App.exitApp) App.exitApp(); }); }
  }
  window.__orbitHaptic=async function(style){
    try{
      if(!hasCap()){ if(navigator.vibrate) navigator.vibrate(style==="error"?30:12); return; }
      var H=plugin("Haptics"); if(!H) return;
      if(style==="success"&&H.notification) await H.notification({type:"SUCCESS"});
      else if(style==="error"&&H.notification) await H.notification({type:"ERROR"});
      else if(H.impact) await H.impact({style:"LIGHT"});
    }catch(e){}
  };
  window.__orbitNativeShare=async function(opts){
    opts=opts||{};
    var Share=plugin("Share"); var Filesystem=plugin("Filesystem");
    if(Share&&Share.share&&Filesystem&&opts.blob&&opts.filename){
      var b64=await new Promise(function(resolve,reject){ var r=new FileReader(); r.onload=function(){ var s=String(r.result||""); var i=s.indexOf(","); resolve(i>=0?s.slice(i+1):s); }; r.onerror=reject; r.readAsDataURL(opts.blob); });
      var path="OrbitBills/"+opts.filename;
      await Filesystem.writeFile({path:path,data:b64,directory:"CACHE",recursive:true});
      var uriRes=await Filesystem.getUri({path:path,directory:"CACHE"});
      var uri=uriRes&&(uriRes.uri||uriRes);
      await Share.share({title:opts.title||"OrbitBills",text:opts.text||"",url:uri,dialogTitle:"Share"});
      return true;
    }
    if(navigator.share){ await navigator.share({title:opts.title,text:opts.text,url:opts.url}); return true; }
    return false;
  };
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", ready); else ready();
  window.addEventListener("load", ready);
})();
