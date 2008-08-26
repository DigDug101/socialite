XULNS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

Components.utils.import("resource://socialite/preferences.jsm");
logger = Components.utils.import("resource://socialite/utils/log.jsm");
logger.init("Socialite", {
  enabled:    SocialitePrefs.getBoolPref("debug"),
  useConsole: SocialitePrefs.getBoolPref("debugInErrorConsole")
});

persistence = Components.utils.import("resource://socialite/persistence.jsm");
Components.utils.import("resource://socialite/site.jsm");

Components.utils.import("resource://socialite/utils/action/action.jsm");
Components.utils.import("resource://socialite/utils/hitch.jsm");

Components.utils.import("resource://socialite/reddit/reddit.jsm");
Components.utils.import("resource://socialite/reddit/redditAPI.jsm");
Components.utils.import("resource://socialite/reddit/bookmarkletAPI.jsm");

document.loadBindingDocument("chrome://socialite/content/reddit/redditBar.xml");

var alertsService = Components.classes["@mozilla.org/alerts-service;1"]
                    .getService(Components.interfaces.nsIAlertsService);

var sessionStore  = Components.classes["@mozilla.org/browser/sessionstore;1"]
                    .getService(Components.interfaces.nsISessionStore);
// ---

const STATE_START = Components.interfaces.nsIWebProgressListener.STATE_START;
const STATE_STOP = Components.interfaces.nsIWebProgressListener.STATE_STOP;
var SocialiteProgressListener =
{
  QueryInterface: function(aIID) {
   if (aIID.equals(Components.interfaces.nsIWebProgressListener) ||
       aIID.equals(Components.interfaces.nsISupportsWeakReference) ||
       aIID.equals(Components.interfaces.nsISupports))
     return this;
   throw Components.results.NS_NOINTERFACE;
  },

  onStateChange: function(aWebProgress, aRequest, aFlag, aStatus) {return 0;},

  onLocationChange: function(aProgress, aRequest, aURI) {
    var window = aProgress.DOMWindow;
    
    if (window == window.top) {
      logger.log("SocialiteProgressListener", "onLocationChange (loading): " + aProgress.DOMWindow.location.href);
      Socialite.linkStartLoad(window, aProgress.isLoadingDocument);
    }
  },
  
  onProgressChange: function() {return 0;},
  onStatusChange: function() {return 0;},
  onSecurityChange: function() {return 0;}
}

// ---

var Socialite = new Object();

Socialite.init = function() {
  window.addEventListener("load", hitchHandler(this, "onLoad"), false);
  window.addEventListener("unload", hitchHandler(this, "onUnload"), false);
}

Socialite.onLoad = function() {
  // initialization code
  this.strings = document.getElementById("socialite-strings");
  
  this.tabBrowser = document.getElementById("content");
  this.appContent = document.getElementById("appcontent");
 
  this.tabBars = [];

  this.sites = new SiteCollection(this);
  this.sites.initialize();
  
  var reddit = new RedditSite("reddit", "www.reddit.com");
  reddit.initialize();
  this.sites.addSite(reddit);
  
  var fuddit = new RedditSite("fuddit", "www.fuddit.com");
  fuddit.initialize();
  this.sites.addSite(fuddit);
  
  this.tabBrowser.addEventListener("DOMContentLoaded", hitchHandler(this, "contentLoad"), false);
  
  // Watch for new tabs to add progress listener to them
  this.tabBrowser.addEventListener("TabOpen", hitchHandler(this, "tabOpened"), false);
  this.tabBrowser.addEventListener("TabClose", hitchHandler(this, "tabClosed"), false);
  
  // Add progress listener to tabbrowser. This fires progress events for the current tab.
  this.setupProgressListener(this.tabBrowser);
};

Socialite.setupProgressListener = function(browser) {
  logger.log("main", "Progress listener added.");
  
  browser.addProgressListener(SocialiteProgressListener,  Components.interfaces.nsIWebProgress.NOTIFY_ALL);
};

Socialite.unsetProgressListener = function(browser) {
  logger.log("main", "Progress listener removed.");
    
  browser.removeProgressListener(SocialiteProgressListener);
};

Socialite.onUnload = function() {
  // Remove remaining progress listeners.
  
  this.unsetProgressListener(this.tabBrowser);
};

Socialite.tabOpened = function(e) {
  var browser = e.originalTarget.linkedBrowser;
  var win = browser.contentWindow;
  
  logger.log("main", "Tab opened: " + win.location.href);
  
  this.linkStartLoad(win, true);
}

Socialite.tabClosed = function(e) {
  var browser = e.originalTarget.linkedBrowser;
  var currentTab = this.tabBrowser.tabContainer.selectedIndex;
  
  this.tabBars[currentTab] = null;
  
  logger.log("main", "Tab closed: " + browser.contentWindow.location.href);
}

Socialite.contentLoad = function(e) {
  var doc = e.originalTarget;
  
  if (doc instanceof HTMLDocument) {
    var win = doc.defaultView;
    if (win == win.top) {
      this.sites.onContentLoad(doc, win);
    }
  }
};

Socialite.linkStartLoad = function(win, isLoading) {
  var href = win.location.href;
  var browser = this.tabBrowser.getBrowserForDocument(win.document);
  var currentTab = this.tabBrowser.tabContainer.selectedIndex;
  var notificationBox = this.tabBrowser.getNotificationBox(browser);

  var bar = this.tabBars[currentTab];
  if (bar) {
    // Handle persistence changes, if any.
    if (!persistence.onLocationChange(bar.url, href)) {
      notificationBox.removeNotification(bar);
    } else { 
      bar.refresh();
    }
  } else if (this.sites.watchedURLs.isWatched(href)) {
    // This is a watched link. Create a notification box and initialize.
    var newBar = this.createNotificationBar(notificationBox);
    newBar.url = href;
    
    this.tabBars[currentTab] = newBar;
    
    // Notification close handler
    newBar.addEventListener("DOMNodeRemoved", hitchThis(this, function(e) {
      if (e.relatedNode == notificationBox) {
        this.tabBars[currentTab] = null;
        logger.log("Socialite", "Notification closed");
      }
    }), false);
    
    // Populate the bar
    for each (entry in this.sites.watchedURLs.getWatches(href)) {
      newBar.addSiteContent(entry.site, entry.site.createBarContent(document, entry.linkInfo));
    };
    newBar.refresh();
  }
}

Socialite.createNotificationBar = function(notificationBox) {
  var notificationName = "socialite-header";

  var notification = notificationBox.appendNotification(
    "",
    notificationName,
    "",
    notificationBox.PRIORITY_INFO_MEDIUM,
    []
  );
  
  // Note: the notification XBL binding is changed by CSS

  // Make the notification immortal -- we'll handle closing it.
  notification.persistence = -1;
  
  logger.log("Socialite", "Notification created");
  return notification;
}

Socialite.failureMessage = function(message) {
  logger.log("Socialite", "Failure occurred, message: " + message);

  alertsService.showAlertNotification(
    "chrome://global/skin/icons/Error.png",
    "Socialite Error",
    message, 
    null, null, null, "socialite-failure"
  );
}

Socialite.openUILink = function(url, e) {
  openUILink(url, e);
}

// ---

Socialite.init();
