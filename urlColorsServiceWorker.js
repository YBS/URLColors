let snoozeTimeout;
let tabGroupingDebounceTimeout;

const TAB_GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
const MIN_TABS_PER_AUTO_GROUP = 1;

const updateValue = (property, value) => {
  chrome.storage.local.set({[property]: value}, () => {
    return;
  });
};

const handleSnooze = (snoozeTime) => {
  clearTimeout(snoozeTimeout);
  const diffInTime = snoozeTime - Date.now();
  if (diffInTime > 0) {
    snoozeTimeout = setTimeout(() => {
      updateValue('snoozeUntil', '');
      sendUpdateMessageToAllTabs('handleSnooze timeout expired');
    }, diffInTime);
  } else {
    updateValue('snoozeUntil', '');
    sendUpdateMessageToAllTabs('handleSnooze timeout expired');
  }
}

const buildKeywordRegex = (keyword) => {
  const wildcardRegex = keyword
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(wildcardRegex, 'i');
}

const parsePreferenceLine = (line, defaults) => {
  const parts = line.split(',').map((s) => s.trim());
  const keyword = parts[0];
  const color = parts[1];
  if (!keyword || !color) {
    return null;
  }
  const thirdValue = parts[2];
  const isFlashValue = thirdValue && thirdValue.toLowerCase() === 'flash';
  const shorthandGroupName = parts.length === 3 && thirdValue && !isFlashValue ? thirdValue : '';
  return {
    keyword,
    color,
    flash: isFlashValue ? thirdValue : '',
    timer: isFlashValue ? parts[3] : '',
    borderWidth: parts[4] || (defaults && defaults.borderWidth),
    opacity: parts[5] || (defaults && defaults.opacity),
    groupName: parts[6] || shorthandGroupName || '',
  };
}

const normalizeTabGroupColor = (color) => {
  if (!color) {
    return 'grey';
  }
  const lower = color.toLowerCase();
  if (TAB_GROUP_COLORS.includes(lower)) {
    return lower;
  }
  if (lower === 'gray') {
    return 'grey';
  }
  if (lower === 'teal') {
    return 'cyan';
  }
  return 'grey';
}

const getGroupableRules = (prefs) => {
  if (!prefs || !prefs.keywords) {
    return [];
  }
  return prefs.keywords
    .split('\n')
    .map((line) => parsePreferenceLine(line, prefs))
    .filter((rule) => rule && rule.groupName);
}

const findGroupMatchForUrl = (url, rules) => {
  if (!url) {
    return null;
  }
  for (const rule of rules) {
    if (buildKeywordRegex(rule.keyword).test(url)) {
      return rule;
    }
  }
  return null;
}

const applyTabGrouping = () => {
  if (!chrome.tabGroups || !chrome.tabs || !chrome.tabs.group) {
    console.log('Tab groups API not available in this Chrome context.');
    return;
  }
  chrome.storage.local.get(['prefs', 'snoozeUntil', 'active'], (data) => {
    if (data.active === false || !data.prefs) {
      return;
    }
    if (data.snoozeUntil && data.snoozeUntil > Date.now()) {
      return;
    }
    const groupableRules = getGroupableRules(data.prefs);
    if (groupableRules.length === 0) {
      return;
    }
    chrome.tabs.query({}, (tabs) => {
      const groupsByWindowAndName = {};
      tabs.forEach((tab) => {
        if (!tab.url || (!tab.url.startsWith('http://') && !tab.url.startsWith('https://'))) {
          return;
        }
        const match = findGroupMatchForUrl(tab.url, groupableRules);
        if (!match) {
          return;
        }
        const key = `${tab.windowId}::${match.groupName}`;
        if (!groupsByWindowAndName[key]) {
          groupsByWindowAndName[key] = {tabIds: [], groupName: match.groupName, color: match.color};
        }
        groupsByWindowAndName[key].tabIds.push(tab.id);
      });
      Object.values(groupsByWindowAndName).forEach((groupData) => {
        if (groupData.tabIds.length < MIN_TABS_PER_AUTO_GROUP) {
          return;
        }
        const firstTabId = groupData.tabIds[0];
        chrome.tabs.get(firstTabId, (firstTab) => {
          if (chrome.runtime.lastError || !firstTab) {
            console.log('Error reading tab before grouping:', chrome.runtime.lastError && chrome.runtime.lastError.message);
            return;
          }
          chrome.tabGroups.query({windowId: firstTab.windowId}, (existingGroups) => {
            if (chrome.runtime.lastError) {
              console.log('Error querying existing tab groups:', chrome.runtime.lastError.message);
              return;
            }
            const existingGroup = (existingGroups || []).find((group) => group.title === groupData.groupName);
            const continueWithGrouping = () => {
              const normalizedGroupColor = normalizeTabGroupColor(groupData.color);
              const targetGroupId = existingGroup ? existingGroup.id : null;
              chrome.tabs.query({windowId: firstTab.windowId}, (windowTabs) => {
                if (chrome.runtime.lastError || !windowTabs) {
                  return;
                }
                const tabsById = {};
                windowTabs.forEach((tab) => {
                  tabsById[tab.id] = tab;
                });
                const tabIdsToGroup = groupData.tabIds.filter((tabId) => {
                  const tab = tabsById[tabId];
                  if (!tab) {
                    return false;
                  }
                  if (targetGroupId !== null) {
                    // If tab is already in the destination group, leave it untouched.
                    return tab.groupId !== targetGroupId;
                  }
                  return true;
                });
                if (tabIdsToGroup.length === 0) {
                  return;
                }
                const groupArgs = targetGroupId !== null
                  ? {groupId: targetGroupId, tabIds: tabIdsToGroup}
                  : {tabIds: tabIdsToGroup};
                chrome.tabs.group(groupArgs, (groupId) => {
                if (chrome.runtime.lastError) {
                  console.log('Error grouping tabs:', chrome.runtime.lastError.message);
                  return;
                }
                if (targetGroupId !== null) {
                  return;
                }
                  applyGroupVisuals(
                    groupId,
                    groupData.groupName,
                    normalizedGroupColor,
                    tabIdsToGroup,
                    () => {
                      // Focus stabilization is only for newly created groups.
                      if (targetGroupId === null) {
                        stabilizeGroupUi(
                          groupId,
                          firstTabId,
                          firstTab.windowId,
                          groupData.groupName,
                          normalizedGroupColor,
                          tabIdsToGroup,
                          2
                        );
                      }
                    }
                  );
                });
              });
            };
            continueWithGrouping();
          });
        });
      });
    });
  });
}

const isNewTabUrl = (url) => {
  if (!url) {
    return false;
  }
  return url === 'chrome://newtab/' || url === 'chrome://newtab' || url === 'about:blank';
}

const stabilizeGroupUi = (groupId, preferredTabId, windowId, groupName, groupColor, tabIds, attemptsLeft) => {
  chrome.tabs.get(preferredTabId, (preferredTab) => {
    if (chrome.runtime.lastError || !preferredTab) {
      console.log('Error reading preferred tab during stabilize:', chrome.runtime.lastError && chrome.runtime.lastError.message);
      return;
    }
    const currentGroupId = preferredTab.groupId !== -1 ? preferredTab.groupId : groupId;
    chrome.tabs.query({windowId: windowId}, (windowTabs) => {
      if (chrome.runtime.lastError || !windowTabs) {
        return;
      }
      const groupedTabs = windowTabs.filter((t) => t.groupId === currentGroupId);
      const groupedTabIds = groupedTabs.map((t) => t.id);
      const targetActiveTabId = groupedTabIds.length > 0 ? groupedTabIds[0] : preferredTabId;
      const verificationTabIds = groupedTabIds.length > 0 ? groupedTabIds : tabIds;
      applyGroupVisuals(currentGroupId, groupName, groupColor, verificationTabIds, () => {
        chrome.tabs.update(targetActiveTabId, {active: true}, () => {
          if (chrome.runtime.lastError) {
            console.log('Error activating grouped tab:', chrome.runtime.lastError.message);
          }
          chrome.tabGroups.get(currentGroupId, (group) => {
            if (chrome.runtime.lastError || !group) {
              console.log('Error reading group during stabilize:', chrome.runtime.lastError && chrome.runtime.lastError.message);
            }
          });
          const activeTab = windowTabs.find((t) => t.active);
          const newTabCandidates = windowTabs.filter((t) => t.groupId === -1 && isNewTabUrl(t.url));
          if (groupedTabs.length === 1 && newTabCandidates.length === 1 && windowTabs.length === 2 && activeTab && activeTab.id === newTabCandidates[0].id) {
            chrome.tabs.remove(newTabCandidates[0].id, () => {
              if (chrome.runtime.lastError) {
                console.log('Error removing auto-created new tab:', chrome.runtime.lastError.message);
              }
            });
          }
        });
      });
    });
  });
  if (attemptsLeft > 0) {
    setTimeout(() => {
      stabilizeGroupUi(groupId, preferredTabId, windowId, groupName, groupColor, tabIds, attemptsLeft - 1);
    }, 350);
  }
}

const applyGroupVisuals = (groupId, groupName, groupColor, tabIds, done) => {
  const forceRepaintExpanded = (afterRepaint) => {
    chrome.tabGroups.update(groupId, {collapsed: true}, () => {
      if (chrome.runtime.lastError) {
        console.log('Error forcing temporary collapse for repaint:', chrome.runtime.lastError.message);
      }
      chrome.tabGroups.update(groupId, {collapsed: false}, () => {
        if (chrome.runtime.lastError) {
          console.log('Error forcing expanded repaint state:', chrome.runtime.lastError.message);
        }
        afterRepaint();
      });
    });
  };
  const verifyAndFinish = () => {
    chrome.tabGroups.get(groupId, (group) => {
      if (chrome.runtime.lastError || !group) {
        console.log('Error reading group after update:', chrome.runtime.lastError && chrome.runtime.lastError.message);
        done();
        return;
      }
      const titleMatches = group.title === groupName;
      const colorMatches = group.color === groupColor;
      if (titleMatches && colorMatches) {
        done();
        return;
      }
      chrome.tabs.ungroup(tabIds, () => {
        if (chrome.runtime.lastError) {
          console.log('Error ungrouping after verification mismatch:', chrome.runtime.lastError.message);
        }
        done();
      });
    });
  };
  chrome.tabGroups.update(groupId, {
    title: groupName,
    color: groupColor,
    collapsed: false,
  }, () => {
    if (!chrome.runtime.lastError) {
      forceRepaintExpanded(verifyAndFinish);
      return;
    }
    console.log('Error setting group title+color together, retrying with fallback:', chrome.runtime.lastError.message);
    chrome.tabGroups.update(groupId, {title: groupName, collapsed: false}, () => {
      if (chrome.runtime.lastError) {
        console.log('Error setting fallback group title:', chrome.runtime.lastError.message);
      }
      chrome.tabGroups.update(groupId, {color: groupColor}, () => {
        if (chrome.runtime.lastError) {
          console.log('Error setting fallback group color:', chrome.runtime.lastError.message);
        }
        forceRepaintExpanded(verifyAndFinish);
      });
    });
  });
}

const scheduleTabGrouping = () => {
  clearTimeout(tabGroupingDebounceTimeout);
  tabGroupingDebounceTimeout = setTimeout(() => {
    applyTabGrouping();
  }, 250);
}

const injectContentScript = (tabId, callback)=> {
    chrome.scripting.executeScript({
        target: {tabId: tabId},
        files: ['urlColorsContentScript.js']
    }, () => {
        if (chrome.runtime.lastError) {
            console.log(`Could not inject script into tab ${tabId}: ${chrome.runtime.lastError.message}`);
        } else if (typeof callback === "function") {
            // Call the callback function if provided
            callback(tabId);
        }
    });
}

const injectContentScriptOnAllTabs = () => {
    chrome.tabs.query({}, (tabs) => {
        tabs.forEach((tab) => {
            if (tab.url.startsWith('http://') || tab.url.startsWith('https://')) {
                injectContentScript(tab.id);
            }
        });
    });
}


const sendMessageToTab = (tabId) => {
    chrome.tabs.sendMessage(tabId, {action: "updateTab"}, response => {
        if (chrome.runtime.lastError) {
            console.error(chrome.runtime.lastError);
        }
    });
}

const attemptToSendMessage = (tabId) => {
    chrome.tabs.sendMessage(tabId, {action: "ping"}, () => {
        if (chrome.runtime.lastError) {
            // No response indicates the script isn't there, inject and then send message
            injectContentScript(tabId, sendMessageToTab);
        } else {
            sendMessageToTab(tabId);
        }
    });
}

const sendUpdateMessageToAllTabs = (originator) => {
    chrome.tabs.query({}, (tabs) => {
        tabs.forEach((tab) => {
            attemptToSendMessage(tab.id);
        });
    });
};


const setBadge = (text, color, title) => {
    chrome.action.setBadgeText({text});
    chrome.action.setBadgeBackgroundColor({color});
    chrome.action.setTitle({title});
}

const setNeedUpdateBadge = () => {
    setBadge('!', 'red', 'Please open the popup to migrate your settings to URLColors V2.');
}

const setSuccessfulUpdateBadge = () => {
    setBadge("✅", "green", "Settings have been migrated successfully");
}

const removeBadge = () => {
    setBadge('', '', '');
}

chrome.runtime.onStartup.addListener(() => {
    injectContentScriptOnAllTabs();
    scheduleTabGrouping();
    // On startup, if snooze is still active, set a timeout to clear it when it expires.
    chrome.storage.local.get(['snoozeUntil'], (result) => {
        if (result.snoozeUntil) {
            handleSnooze(result.snoozeUntil);
        }
    });
});

chrome.runtime.onInstalled.addListener((details) => {
    injectContentScriptOnAllTabs();
    scheduleTabGrouping();
    if (details.reason === "update" && details.previousVersion === "1.1.2") {
        // Notify the user to open the popup for completing the migration
        setNeedUpdateBadge();
    }
});

chrome.tabs.onUpdated.addListener(
    (tabId, changeInfo, tab) => {
        if (changeInfo.status !== 'complete') {
          return;
        }
        if (!tab.url || (!tab.url.startsWith('http://') && !tab.url.startsWith('https://'))) {
          return;
        }
        chrome.tabs.sendMessage(tab.id, { action: "updateTab" }, (response) => {
            if (chrome.runtime.lastError) {
              console.error(chrome.runtime.lastError);
            }
        });
        scheduleTabGrouping();
    }
);
chrome.storage.onChanged.addListener((changes, namespace) => {
  if ((changes.prefs || changes.snoozeUntil || changes.active || changes.titlePrefixEnabled) && namespace === 'local') {
    if (changes.snoozeUntil && changes.snoozeUntil.newValue) {
      handleSnooze(changes.snoozeUntil.newValue);
    }
    sendUpdateMessageToAllTabs('storage.onChanged listener');
    scheduleTabGrouping();
  }
});


// Message receiving
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "settingsMigrated") {
        setSuccessfulUpdateBadge();
    }
    if (message.action === 'removeBadge') {
       removeBadge();
    }
});
