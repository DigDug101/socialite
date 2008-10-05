let modules = {};
let importModule = function(name) Components.utils.import(name, modules);

let Socialite = importModule("resource://socialite/socialite.jsm").Socialite;
let logger = importModule("resource://socialite/utils/log.jsm");
let persistence = importModule("resource://socialite/persistence.jsm");

let observerService = Components.classes["@mozilla.org/observer-service;1"]
                      .getService(Components.interfaces.nsIObserverService);

let SOCIALITE_CONTENT_NOTIFICATION_VALUE = "socialite-contentbar-notification";
let SOCIALITE_SUBMIT_NOTIFICATION_VALUE = "socialite-submitbar-notification"; 

// ---

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
    let window = aProgress.DOMWindow;
    if ((window == window.top) && aURI) {
      SocialiteWindow.linkStartLoad(aURI.spec, window, aProgress.isLoadingDocument);
    }
  },
  
  onProgressChange: function() {return 0;},
  onStatusChange: function() {return 0;},
  onSecurityChange: function() {return 0;}
}

// ---

var SocialiteWindow = 
{
  
  init: function() {
    SocialiteWindow.stringBundle = Components.classes["@mozilla.org/intl/stringbundle;1"]
                                   .getService(Components.interfaces.nsIStringBundleService)
                                   .createBundle("chrome://socialite/locale/socialite.properties")
                                   
    window.addEventListener("load", SocialiteWindow.onLoad, false);
    window.addEventListener("unload", SocialiteWindow.onUnload, false);
  },
  
  onLoad: function() {
    Socialite.load();
    
    observerService.addObserver(SocialiteWindow.siteObserver, "socialite-load-site", false);
    observerService.addObserver(SocialiteWindow.siteObserver, "socialite-unload-site", false);
    
    Socialite.preferences.addObserver("", SocialiteWindow.preferenceObserver, false);
    
    SocialiteWindow.SiteUrlBarIcon.onLoad();
    SocialiteWindow.SiteMenuItem.onLoad();
    
    gBrowser.addEventListener("TabClose", function(event) {
      // XXX: Call close methods for notifications if they exist, since they won't be called otherwise
      var selectedBrowser = event.originalTarget.linkedBrowser;
      var notificationBox = gBrowser.getNotificationBox(selectedBrowser);
      
      var socialiteBar = notificationBox.getNotificationWithValue(SOCIALITE_CONTENT_NOTIFICATION_VALUE);
      if (socialiteBar) { socialiteBar.fireCloseEvent(); }
      
      var submitBar = notificationBox.getNotificationWithValue(SOCIALITE_SUBMIT_NOTIFICATION_VALUE);
      if (submitBar) { submitBar.fireCloseEvent(); }
      
      logger.log("main", "Tab closed: " + selectedBrowser.currentURI.spec);
    }, false);
    
    // Site content load handler
    gBrowser.addEventListener("DOMContentLoaded", function(event) {
      var doc = event.originalTarget;
      
      if (doc instanceof HTMLDocument) {
        var win = doc.defaultView;
        if (win == win.top) {
          Socialite.sites.onContentLoad(doc, win);
        }
      }
    }, false);
    
    // Kill javascript redirects dead
    gBrowser.addEventListener("beforeunload", function(event) {
      let doc = event.originalTarget;
      let win = doc.defaultView;
      let originalURL = doc.URL;
      if ((doc instanceof HTMLDocument) && (win == win.top) && Socialite.watchedURLs.isWatched(originalURL)) {
        let browser = gBrowser.getBrowserForDocument(doc);
        if (browser) {
          if (browser.docShell.isExecutingOnLoadHandler) {
            logger.log("main", "Catching Javascript redirect...");
            
            // Interestingly, as far as I can tell from nsDocShell.cpp, we can't get the destination URL at this point
            // However, the onLocationChange trigger on a ProgressListener will get called immediately after the page changes...
            let redirectProgressListener = {
              QueryInterface: function(aIID) {
                if (aIID.equals(Components.interfaces.nsIWebProgressListener) ||
                     aIID.equals(Components.interfaces.nsISupportsWeakReference) ||
                     aIID.equals(Components.interfaces.nsISupports))
                   return this;
                 throw Components.results.NS_NOINTERFACE;
              },
              onStateChange: function(aWebProgress, aRequest, aFlag, aStatus) {return 0;},
              onLocationChange: function(aProgress, aRequest, aURI) {
                logger.log("main", "Detected Javascript redirect: "+ originalURL +" -> "+ aURI.spec);
                Socialite.watchedURLs.addRedirect(originalURL, aURI.spec);
                browser.removeProgressListener(redirectProgressListener);
              },
              onProgressChange: function() {return 0;},
              onStatusChange: function() {return 0;},
              onSecurityChange: function() {return 0;}
            }
            browser.addProgressListener(redirectProgressListener);
          }
        }
      }
    }, true);
    
    // Add progress listener to tabbrowser. This fires progress events for the current tab.
    SocialiteWindow.setupProgressListener(gBrowser);
  },
  
  onUnload: function() {
    SocialiteWindow.SiteUrlBarIcon.onUnload();
    SocialiteWindow.SiteMenuItem.onUnload();
    
    Socialite.preferences.removeObserver("", SocialiteWindow.preferenceObserver);
    
    observerService.removeObserver(SocialiteWindow.siteObserver, "socialite-load-site");
    observerService.removeObserver(SocialiteWindow.siteObserver, "socialite-unload-site");
    // Remove remaining progress listeners.
    SocialiteWindow.unsetProgressListener(gBrowser);
  },
  
  setupProgressListener: function(browser) {
    logger.log("main", "Progress listener added.");
    browser.addProgressListener(SocialiteProgressListener, Components.interfaces.nsIWebProgress.NOTIFY_ALL);
  },
  
  unsetProgressListener: function(browser) {
    logger.log("main", "Progress listener removed.");
    browser.removeProgressListener(SocialiteProgressListener);
  },

  linkStartLoad: function(URL, win, isLoading) {
    let browser = gBrowser.getBrowserForDocument(win.document);
    let notificationBox = gBrowser.getNotificationBox(browser);

    // Check for and store a HTTP redirect
    let channel = browser.docShell.currentDocumentChannel;
    if (channel) {
      let originalURL = channel.originalURI.spec;

      if ((channel.loadFlags & Components.interfaces.nsIChannel.LOAD_REPLACE)
          && (Socialite.watchedURLs.isWatched(originalURL) || Socialite.watchedURLs.isWatched(URL))) {
        logger.log("linkStartLoad", "Detected redirect: "+ originalURL +" -> "+ URL);
        Socialite.watchedURLs.addRedirect(originalURL, URL);
      }
    }
    
    // Handle an existing bar
    let socialiteBar = notificationBox.getNotificationWithValue(SOCIALITE_CONTENT_NOTIFICATION_VALUE);
    if (socialiteBar) {
      let isFromRedirect = Socialite.watchedURLs.isRedirect(socialiteBar.originalURL, URL);
      let isPersistenceChange = persistence.onLocationChange(socialiteBar.URL, URL);
      // Handle persistence changes, if any.
      if (!isFromRedirect && !isPersistenceChange) {
        notificationBox.removeNotification(socialiteBar);
        socialiteBar = null;
      } else {
        // If we got redirected, update the bar URL so persistence rules are followed correctly.
        if (isFromRedirect) {
          socialiteBar.URL = URL;
        }
        // If we're not closing the bar, refresh it.
        socialiteBar.refresh();
      }
    }
    
    // Open a new bar if one is not already open, and the link is watched
    if (!socialiteBar && Socialite.watchedURLs.isWatched(URL)) {
      let watchInfo = Socialite.watchedURLs.get(URL);
      if (!watchInfo.hidden) {
        // This is a watched link. Create a notification box and initialize.
        var newBar = SocialiteWindow.createContentBar(notificationBox, URL);
        
        // Populate the bar
        for each (let [siteID, linkInfo] in watchInfo) {
          let site = Socialite.sites.byID[siteID];
          newBar.addSiteUI(site, site.createBarContentUI(document, linkInfo));
        }
      }
    }
  },
  
  createContentBar: function(notificationBox, URL) {
    var notification = notificationBox.appendNotification(
      "",
      SOCIALITE_CONTENT_NOTIFICATION_VALUE,
      "",
      notificationBox.PRIORITY_INFO_LOW,
      []
    );
    
    // Note: the notification XBL binding is changed by CSS
  
    // Make the notification immortal -- we'll handle closing it.
    notification.persistence = -1;
    
    // Set url property so we know the location the bar was originally opened for.
    notification.originalURL = URL;
    notification.URL = URL;
    
    // If the user closes the notification manually, we'll set the watch to hidden, suppressing automatic display.
    notification.addEventListener("SocialiteNotificationClosedByUser", function(event) {
      if (Socialite.watchedURLs.isWatched(notification.originalURL)) {
        Socialite.watchedURLs.get(notification.originalURL).hidden = true;
      }
    }, false);
    
    logger.log("SocialiteWindow", "Content notification created");
    return notification;
  },
  
  createSubmitBar: function(notificationBox, URL) {
    var notification = notificationBox.appendNotification(
      "",
      SOCIALITE_SUBMIT_NOTIFICATION_VALUE,
      "",
      notificationBox.PRIORITY_INFO_MEDIUM, // Appear on top of socialite content notifications
      []
    );
    
    // Note: the notification XBL binding is changed by CSS
    
    // Make the notification immortal
    notification.persistence = -1;
    
    // Set url property so we know the location the bar was originally opened for.
    notification.URL = URL;
    
    logger.log("SocialiteWindow", "Submit notification created");
    return notification;
  },
  
  linkContextAction: function(site, event, forceSubmit, finishedCallback) {
    let selectedBrowser = gBrowser.selectedBrowser;
    let currentURL = selectedBrowser.currentURI.spec;
    let notificationBox = gBrowser.getNotificationBox(selectedBrowser);
   
    //
    // *** Helper functions ***
    //
    
    // Helper function to open the bar with some content.
    function openContentBarTo(site, siteUI) {
      let socialiteBar = notificationBox.getNotificationWithValue(SOCIALITE_CONTENT_NOTIFICATION_VALUE);
      if (socialiteBar && socialiteBar.URL != currentURL) {
        // The bar was opened for another URL. We will replace it.
        socialiteBar.close();
        socialiteBar = null;
      }
      if (!socialiteBar) {
        socialiteBar = SocialiteWindow.createContentBar(notificationBox, currentURL);
      }
      socialiteBar.addSiteUI(site, siteUI);
    }
    
    // Helper function to open the submit bar with a particular destination site selected.
    function openSubmitBarTo(site) {
      let submitBar = notificationBox.getNotificationWithValue(SOCIALITE_SUBMIT_NOTIFICATION_VALUE);
      if (!submitBar) {
        submitBar = SocialiteWindow.createSubmitBar(notificationBox, currentURL);
      }
      if (site) {
        submitBar.siteSelector.selectSite(site);
      }
    }
    
    // Helper function to get link info from a watch, falling back to querying the site
    function getWatchLinkInfo(URL, site, callback) {
      let watchLinkInfo = Socialite.watchedURLs.getBy(currentURL, site);
      if (watchLinkInfo) {
        // If the site is watched, return the stored information.
        openContentBarTo(site, site.createBarContentUI(document, watchLinkInfo));
        callback(watchLinkInfo);
      } else {
        // We have no local information about the URL, so we need to check the Socialite site to see if the URL is already submitted.
        site.getLinkInfo(currentURL, function(linkInfo) {
          if (linkInfo) {
            openContentBarTo(site, site.createBarContentUI(document, linkInfo));
          }
          callback(linkInfo);
        });
      }
    }
    
    // Helper function to sequentially call getWatchLinkInfo for a group of sites.
    // Since each call happens asynchronously, we iterate by making a chain of callbacks.
    function getSiteWatchLinkInfos(URL, sites, callback) {
      linkInfos = [];
      
      // Iterate over each site given
      siteIterator = Iterator(sites);
      
      function next(linkInfo) {
        linkInfos.push(linkInfo);
        try {
          let [siteID, site] = siteIterator.next();
          getWatchLinkInfo(URL, site, next);
        } catch (e if e instanceof StopIteration) {
          // No more sites left. We're done.
          callback(linkInfos);
        }
      }
      
      // Get the sequence started.
      let [siteID, site] = siteIterator.next();
      getWatchLinkInfo(URL, site, next);
    }
    
    //
    // *** Context Logic ***
    //
    
    let currentSocialiteBar = notificationBox.getNotificationWithValue(SOCIALITE_CONTENT_NOTIFICATION_VALUE);
    let currentSubmitBar = notificationBox.getNotificationWithValue(SOCIALITE_SUBMIT_NOTIFICATION_VALUE);
    
    // *** Step 1: Identify UI cases where the intended action is clearly to submit
    
    let shouldSubmit = false;
    
    // Middle-click forces submit action
    shouldSubmit |= (event.button == 1 || forceSubmit);
    
    // If the submit bar is already open, we will simply update it
    shouldSubmit |= (currentSubmitBar != null);
    
    // If the content bar is already open, we will open the submit bar, with one exception:
    // If a single site has been specified, and the content bar does not have it loaded, we should perform a lookup instead.
    shouldSubmit |= ((currentSocialiteBar != null) && ((site == null) || currentSocialiteBar.hasSiteUI(site)));
    
    if (shouldSubmit) {
      openSubmitBarTo(site);
      if (finishedCallback) { finishedCallback(); }
    } else {
      
      // *** Step 2: We must check the link info and figure out whether the link has been posted before.
      // If it exists on any sites, open content bar. Otherwise, open submit bar.
      // Also, if a user has hidden a watch, they can use the context action to re-show it.
      // Thus, if the URL is watched and hidden/suppressed, activate it.
      if (site) {
        // If a specific site is specified, only activate if the URL is watched by that site.
        if (Socialite.watchedURLs.isWatchedBy(currentURL, site)) {
          Socialite.watchedURLs.get(currentURL).activate();
        }
        
        getWatchLinkInfo(currentURL, site, function(linkInfo) {
          if (!linkInfo) {
            // If we didn't find any linkInfo, open the submit bar
            openSubmitBarTo(site);
          }
          if (finishedCallback) { finishedCallback(); }
        });
        
      } else {
        if (Socialite.watchedURLs.isWatched(currentURL, site)) {
          Socialite.watchedURLs.get(currentURL).activate();
        }
        
        getSiteWatchLinkInfos(currentURL, Socialite.sites, function(linkInfos) {
          // If every linkInfo is null, we didn't find anything.
          if (linkInfos.every(function(x) x == null)) {
            // If we didn't find a single site that knows about this link, open the submit bar 
            openSubmitBarTo();
          }
          if (finishedCallback) { finishedCallback(); }
        });
      }
    }
  },

  siteObserver: { 
    
    observe: function(subject, topic, data) {
      let site = Socialite.sites.byID[data];
      switch (topic) {
      
        case "socialite-load-site":
          SocialiteWindow.SiteUrlBarIcon.create(site);
          SocialiteWindow.SiteMenuItem.create(site);
          break;
          
        case "socialite-unload-site":
          SocialiteWindow.SiteUrlBarIcon.remove(site);
          SocialiteWindow.SiteMenuItem.remove(site);
          for (let i=0; i<gBrowser.browsers.length; i++) {
            let browser = gBrowser.browsers[i];
            socialiteBar = gBrowser.getNotificationBox(browser).getNotificationWithValue(SOCIALITE_CONTENT_NOTIFICATION_VALUE);
            if (socialiteBar) {
              socialiteBar.removeSiteUI(site);
            }
          }
          break;
          
      }
    }
  
  },
  
  preferenceObserver: {
    
    observe: function(subject, topic, data) {
      // data is of the form siteID.preference
      let splitData = data.split(".");
      let prefStart = splitData[0];
      switch (prefStart) {
      
        case "sites":
          let [prefStart, siteID, prefName] = splitData;
          // Update the UI if the site name changes.
          if (prefName == "siteName") {
            let newSiteName = Socialite.preferences.getCharPref(data);
            let site = Socialite.sites.byID[siteID];
            if (site) {
              SocialiteWindow.SiteUrlBarIcon.updateSiteName(site, newSiteName);
              SocialiteWindow.SiteMenuItem.updateSiteName(site, newSiteName);
            }
          }
          break;
          
        case "showSiteUrlBarIcons":
          SocialiteWindow.SiteUrlBarIcon.updateVisibility();
          break;
          
        case "showSiteMenuItems":
          SocialiteWindow.SiteMenuItem.updateVisibility();
          break;
          
        case "consolidateSites":
          SocialiteWindow.SiteUrlBarIcon.updateVisibility();
          SocialiteWindow.SiteMenuItem.updateVisibility();
          break;
          
      }
    }
  
  }

}

SocialiteWindow.init();
