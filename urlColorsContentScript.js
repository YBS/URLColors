const logMessageIfEnabled = (...args) => {
    chrome.storage.local.get(['logging'], (data) => {
        if (data.logging) {
        console.log(...args);
        }
    });
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
    borderWidth: parts[4] || defaults?.borderWidth,
    opacity: parts[5] || defaults?.opacity,
    groupName: parts[6] || shorthandGroupName || '',
  };
}


const removePreviousDivs = () => {
  const divs = document.getElementsByClassName('colordiv');
  Object.keys(divs).forEach(() => {
    if (divs[0]) {
      divs[0].parentNode.removeChild(divs[0]);
    }
  });
}

const addNewDivs = (color, flash, timer, borderWidth, opacity) => {
  const style = document.createElement('style');
  style.innerHTML = `.urlColorAnimate { animation: blinker ${timer}s linear infinite; } @keyframes blinker { 0% { opacity: ${opacity}; } 50% { opacity: 0; } 100% { opacity: ${opacity}; } }`;
  document.getElementsByTagName('head')[0].appendChild(style);
  const leftDiv = document.createElement('div');
  const rightDiv = document.createElement('div');
  const topDiv = document.createElement('div');
  const bottomDiv = document.createElement('div');

  const divs = [leftDiv, rightDiv, topDiv, bottomDiv];
  const horizontal = [topDiv, bottomDiv];
  const vertical = [rightDiv, leftDiv];

  divs.forEach((div) => {
    div.setAttribute('class', 'colordiv');
    div.style.background = color;
    div.style.position = 'fixed';
    div.style.opacity = opacity;
    div.style.zIndex = '99999999999999';
    div.style.pointerEvents = 'none';
  });

  horizontal.forEach((div) => {
    div.style.left = '0';
    div.style.right = '0';
    div.style.height = borderWidth;
  });

  vertical.forEach((div) => {
    div.style.top = '0';
    div.style.bottom = '0';
    div.style.width = borderWidth;
  });

  leftDiv.style.left = '0';
  rightDiv.style.right = '0';
  topDiv.style.top = '0';
  bottomDiv.style.bottom = '0';

  divs.forEach((div) => {
    document.body.appendChild(div);
    if (flash === 'flash') {
      div.classList.add('urlColorAnimate');
    }
  });
}

const getMatchedPrefs = (prefs) => {
  const currentUrl = window.location.href;
  const matchedPrefs = [];

  prefs.keywords.split('\n').forEach(line => {
    if (!line) {
      return;
    }
    const parsedLine = parsePreferenceLine(line, prefs);
    if (!parsedLine) {
      return;
    }
    const regex = buildKeywordRegex(parsedLine.keyword);

    // If the current URL matches the keyword pattern
    if (regex.test(currentUrl)) {
      matchedPrefs.push(parsedLine);
    }
  });
  return matchedPrefs;
}


const updatePageWithPrefs = (matchedPrefs, defaultBorderWidth, defaultOpacity) => {
  // Iterate through each line of preferences
  matchedPrefs.forEach(pref => {
    const { keyword, color, flash, timer, borderWidth = defaultBorderWidth, opacity = defaultOpacity } = pref;
    logMessageIfEnabled(`URLColors: applying matched keyword '${keyword}'`);
    removePreviousDivs();
    addNewDivs(color, flash, timer, borderWidth, opacity);
  });
}

const applyPreferences = () => {
  chrome.storage.local.get(['prefs', 'snoozeUntil', 'active'], (data) => {
    if (data.active === false || !data.prefs) {
      logMessageIfEnabled("URLColors: Extension is not active.");
      removePreviousDivs();
      return;
    }
    const now = Date.now();
    if (data.snoozeUntil && data.snoozeUntil > now) {
      logMessageIfEnabled("URLColors: Extension is snoozed.");
      removePreviousDivs();
      return;
    }
    const matchedPrefs = getMatchedPrefs(data.prefs);
    if (matchedPrefs.length === 0) {
      logMessageIfEnabled(`URLColors: No match found for URL: ${window.location.href}.`, data.prefs);
        removePreviousDivs();
        return;
    }
    logMessageIfEnabled(`URLColors: ${matchedPrefs.length} match(s) found for URL: ${window.location.href}. Updating page with border preferences.`, matchedPrefs);
    updatePageWithPrefs(matchedPrefs, data?.prefs?.borderWidth, data?.prefs?.opacity);
  });
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "ping") {
    // Respond to indicate the script is present
    sendResponse({status: "present"});
  }
  if (message.action === 'updateTab') {
    applyPreferences();
    sendResponse('updated tab')
  }
});


document.addEventListener('DOMContentLoaded', applyPreferences);
