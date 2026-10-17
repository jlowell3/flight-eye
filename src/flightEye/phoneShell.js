/**
 * The Flight Eye phone layer: a bottom action bar, a telemetry sheet for the
 * tracked aircraft, contact filter chips and a menu sheet, driving the
 * existing shell through its facade and its own buttons. It is on when the
 * pointer is coarse (or `?ui=phone`), and it owns nothing the desktop shell
 * owns: every action here is one the desktop reaches with a click or a key.
 * Decisions live in src/flightEye/phonePolicy.js.
 */

import { msg, t } from '../i18n/index.js';
import { configureTrackingClickGesture } from '../data/trackingClickGesture.js';
import {
  ACTION_LABELS,
  CONTACT_FILTERS,
  actionBarState,
  backAction,
  contactNavigationOptions,
  isPhoneUi,
  nextVisualStyle,
  telemetrySummary,
} from './phonePolicy.js';

/** A finger's click travel limit, against the mouse's 6 px. */
export const PHONE_TRACKING_TRAVEL_PX = 14;
const REFRESH_MS = 1000;
const TRACKED_LAYERS = ['flights', 'military'];

const MENU_ITEMS = Object.freeze([
  { id: 'hud', label: msg('HUD'), icon: 'visibility', button: 'hud-toggle' },
  {
    id: 'detect',
    label: msg('DETECT'),
    icon: 'radar',
    button: 'detection-toggle',
  },
  {
    id: 'models',
    label: msg('3D MODELS'),
    icon: 'view_in_ar',
    button: 'models3d-toggle',
  },
  { id: 'layers', label: msg('LAYERS'), icon: 'right_panel_open' },
  { id: 'globe', label: msg('GLOBE'), icon: 'public' },
  {
    id: 'share',
    label: msg('SHARE'),
    icon: 'arrow_forward',
    button: 'share-btn',
  },
]);

function element(doc, tag, attributes = {}, children = []) {
  const node = doc.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    if (name === 'className') node.className = value;
    else if (name === 'text') node.textContent = value;
    else node.setAttribute(name, String(value));
  }
  for (const child of children) if (child) node.appendChild(child);
  return node;
}

function icon(doc, name) {
  return element(doc, 'span', {
    className: 'material-symbols-outlined',
    'aria-hidden': 'true',
    text: name,
  });
}

function actionButton(doc, { id, iconName, label }) {
  return element(doc, 'button', { type: 'button', 'data-action': id }, [
    icon(doc, iconName),
    element(doc, 'span', { className: 'fe-action-label', text: label }),
  ]);
}

/**
 * Mount the phone layer when the device calls for it. Returns a handle with
 * `destroy`, or null on a desktop pointer.
 */
export function initPhoneShell({
  application,
  documentRef = globalThis.document,
  windowRef = globalThis.window,
}) {
  if (
    !isPhoneUi({
      matchMedia: windowRef?.matchMedia?.bind(windowRef),
      search: windowRef?.location?.search,
    })
  )
    return null;
  const { controls, data, tools } = application.getComponents();
  const styleManager = controls?.styleManager;
  const dataManager = data?.dataManager;
  if (!styleManager || !dataManager) return null;
  const doc = documentRef;
  const body = doc.body;
  body.classList.add('ui-phone');
  configureTrackingClickGesture({ travelPx: PHONE_TRACKING_TRAVEL_PX });

  const state = { filterId: 'all', menuOpen: false, sheetExpanded: false };
  const byId = (id) => doc.getElementById(id);
  const trackedModule = () => {
    for (const layerId of TRACKED_LAYERS) {
      const module = dataManager.layers.get(layerId)?.module;
      try {
        if (module?.getTrackedInfo?.()) return module;
      } catch {
        // The layer is not ready; nothing is tracked there.
      }
    }
    return null;
  };
  const trackedInfo = () => {
    try {
      return trackedModule()?.getTrackedInfo?.() ?? null;
    } catch {
      return null;
    }
  };
  const cockpitState = () => styleManager.getCockpitState?.() ?? null;
  const contactsActive = () =>
    styleManager.getContextModeState?.()?.mode === 'flights';

  // Telemetry sheet.
  const telemetryTitle = element(doc, 'span', {
    className: 'fe-telemetry-title',
  });
  const telemetrySubtitle = element(doc, 'span', {
    className: 'fe-telemetry-subtitle',
  });
  const telemetryEmergency = element(doc, 'span', {
    className: 'fe-telemetry-emergency',
  });
  const telemetryReadouts = element(doc, 'dl', {
    className: 'fe-telemetry-readouts',
  });
  const telemetry = element(
    doc,
    'section',
    {
      id: 'fe-telemetry',
      'data-visible': 'false',
      'data-expanded': 'false',
      'aria-label': t('Tracked aircraft'),
    },
    [
      element(doc, 'div', { className: 'fe-telemetry-head' }, [
        telemetryTitle,
        telemetrySubtitle,
        telemetryEmergency,
      ]),
      telemetryReadouts,
    ],
  );

  // Contact filter chips.
  const chips = element(doc, 'div', {
    id: 'fe-chips',
    role: 'group',
    'data-visible': 'false',
    'aria-label': t('Contact filter'),
  });
  for (const filter of CONTACT_FILTERS) {
    chips.appendChild(
      element(doc, 'button', {
        type: 'button',
        'data-filter': filter.id,
        'aria-pressed': String(filter.id === state.filterId),
        text: t(filter.label),
      }),
    );
  }

  // Action bar.
  const buttons = {
    previous: actionButton(doc, {
      id: 'previous',
      iconName: 'chevron_left',
      label: t(ACTION_LABELS.previous),
    }),
    track: actionButton(doc, {
      id: 'track',
      iconName: 'my_location',
      label: t(ACTION_LABELS.focus),
    }),
    cockpit: actionButton(doc, {
      id: 'cockpit',
      iconName: 'flight',
      label: t(ACTION_LABELS.cockpit),
    }),
    sensor: actionButton(doc, {
      id: 'sensor',
      iconName: 'flare',
      label: t(ACTION_LABELS.sensor),
    }),
    next: actionButton(doc, {
      id: 'next',
      iconName: 'chevron_right',
      label: t(ACTION_LABELS.next),
    }),
    menu: element(doc, 'button', { type: 'button', 'data-action': 'menu' }, [
      element(doc, 'span', { 'aria-hidden': 'true', text: '⋯' }),
      element(doc, 'span', {
        className: 'fe-action-label',
        text: t(ACTION_LABELS.menu),
      }),
    ]),
  };
  const bar = element(
    doc,
    'nav',
    { id: 'fe-action-bar', 'aria-label': t('Flight controls') },
    Object.values(buttons),
  );

  // Menu sheet.
  const menuGrid = element(doc, 'div', { className: 'fe-menu-grid' });
  for (const item of MENU_ITEMS) {
    menuGrid.appendChild(
      element(doc, 'button', { type: 'button', 'data-menu': item.id }, [
        icon(doc, item.icon),
        element(doc, 'span', { text: t(item.label) }),
      ]),
    );
  }
  const menuClose = element(doc, 'button', {
    type: 'button',
    className: 'fe-menu-close',
    text: t('CLOSE'),
  });
  const menu = element(
    doc,
    'section',
    { id: 'fe-menu', 'data-open': 'false', 'aria-label': t('More controls') },
    [menuGrid, menuClose],
  );
  const scrim = element(doc, 'div', { id: 'fe-scrim', 'data-open': 'false' });

  body.append(scrim, chips, telemetry, bar, menu);

  const setMenuOpen = (open) => {
    state.menuOpen = Boolean(open);
    menu.dataset.open = String(state.menuOpen);
    scrim.dataset.open = String(state.menuOpen);
    buttons.menu.setAttribute('aria-pressed', String(state.menuOpen));
    if (state.menuOpen) refreshMenu();
  };

  const refreshMenu = () => {
    for (const item of MENU_ITEMS) {
      const target = item.button ? byId(item.button) : null;
      const pressed =
        item.id === 'layers'
          ? byId('data-panel')?.classList.contains('active')
          : target?.getAttribute('aria-pressed') === 'true' ||
            target?.classList.contains('active');
      menuGrid
        .querySelector(`[data-menu="${item.id}"]`)
        ?.setAttribute('aria-pressed', String(Boolean(pressed)));
    }
  };

  const renderTelemetry = () => {
    const summary = telemetrySummary(trackedInfo());
    telemetry.dataset.visible = String(Boolean(summary));
    if (!summary) return;
    telemetry.dataset.stale = String(summary.stale);
    telemetry.dataset.expanded = String(state.sheetExpanded);
    telemetryTitle.textContent = summary.title || '';
    telemetrySubtitle.textContent = summary.subtitle || '';
    telemetryEmergency.textContent = summary.emergency || '';
    telemetryEmergency.hidden = !summary.emergency;
    telemetryReadouts.replaceChildren(
      ...summary.readouts.flatMap(({ label, value }) => [
        element(doc, 'div', {}, [
          element(doc, 'dt', { text: t(label) }),
          element(doc, 'dd', {
            text: typeof value === 'string' ? value : t(value),
          }),
        ]),
      ]),
    );
  };

  const refresh = () => {
    const cockpit = cockpitState();
    const view = actionBarState({
      tracked: Boolean(trackedInfo()),
      cockpitActive: cockpit?.active === true,
      cockpitEntryAllowed: cockpit?.entryAllowed === true,
      contactsActive: contactsActive(),
    });
    buttons.track.querySelector('.fe-action-label').textContent = t(
      view.trackLabel,
    );
    buttons.track.querySelector('.material-symbols-outlined').textContent =
      view.trackLabel === ACTION_LABELS.untrack ? 'close' : 'my_location';
    buttons.track.disabled = !view.trackEnabled;
    buttons.cockpit.querySelector('.fe-action-label').textContent = t(
      view.cockpitLabel,
    );
    buttons.cockpit.querySelector('.material-symbols-outlined').textContent =
      view.cockpitLabel === ACTION_LABELS.exit ? 'close_fullscreen' : 'flight';
    buttons.cockpit.disabled = !view.cockpitEnabled;
    buttons.cockpit.setAttribute(
      'aria-pressed',
      String(cockpit?.active === true),
    );
    buttons.previous.disabled = !view.navigationEnabled;
    buttons.next.disabled = !view.navigationEnabled;
    chips.dataset.visible = String(view.chipsVisible);
    renderTelemetry();
    if (state.menuOpen) refreshMenu();
  };

  const act = {
    track() {
      const module = trackedModule();
      if (module) {
        module.stopTracking?.({ origin: 'user' });
        return;
      }
      const awareness = dataManager.layers.get('military-awareness')?.module;
      if (!contactsActive()) {
        void Promise.resolve(styleManager.setContextMode('contacts')).then(
          () => {
            awareness?.focusCurrent?.({ origin: 'user' });
            refresh();
          },
        );
        return;
      }
      awareness?.focusCurrent?.({ origin: 'user' });
    },
    cockpit() {
      const active = cockpitState()?.active === true;
      styleManager.controlCockpit(active ? 'exit' : 'enter');
    },
    previous() {
      styleManager.controlCockpit(
        'previous',
        contactNavigationOptions(state.filterId),
      );
    },
    next() {
      styleManager.controlCockpit(
        'next',
        contactNavigationOptions(state.filterId),
      );
    },
    sensor() {
      if (cockpitState()?.active === true) {
        byId('cockpit-vision-next')?.click();
        return;
      }
      const current = styleManager.getVisualState?.()?.style;
      styleManager.setStyle(nextVisualStyle(current), { userInitiated: true });
    },
    menu() {
      setMenuOpen(!state.menuOpen);
    },
  };
  const menuAct = {
    hud: () => byId('hud-toggle')?.click(),
    detect: () => byId('detection-toggle')?.click(),
    models: () => byId('models3d-toggle')?.click(),
    layers: () => byId('data-panel')?.classList.toggle('active'),
    globe: () => {
      setMenuOpen(false);
      void styleManager.resetToGlobeView?.();
    },
    share: () => {
      setMenuOpen(false);
      byId('share-btn')?.click();
    },
  };

  const listeners = new AbortController();
  const { signal } = listeners;
  bar.addEventListener(
    'click',
    (event) => {
      const action = event.target.closest?.('[data-action]')?.dataset.action;
      if (!action || !act[action]) return;
      act[action]();
      refresh();
    },
    { signal },
  );
  chips.addEventListener(
    'click',
    (event) => {
      const filterId = event.target.closest?.('[data-filter]')?.dataset.filter;
      if (!filterId) return;
      state.filterId = filterId;
      for (const chip of chips.querySelectorAll('[data-filter]'))
        chip.setAttribute(
          'aria-pressed',
          String(chip.dataset.filter === filterId),
        );
    },
    { signal },
  );
  telemetry.addEventListener(
    'click',
    () => {
      state.sheetExpanded = !state.sheetExpanded;
      telemetry.dataset.expanded = String(state.sheetExpanded);
    },
    { signal },
  );
  menu.addEventListener(
    'click',
    (event) => {
      const id = event.target.closest?.('[data-menu]')?.dataset.menu;
      if (id && menuAct[id]) {
        menuAct[id]();
        refreshMenu();
        return;
      }
      if (event.target.closest?.('.fe-menu-close')) setMenuOpen(false);
    },
    { signal },
  );
  scrim.addEventListener('click', () => setMenuOpen(false), { signal });

  // Hold the voice button to talk; a tap still toggles the session.
  const voiceButton = byId('gev-voice-button');
  if (voiceButton) tools?.voiceCommands?.bindPushToTalkPointer?.(voiceButton);

  // The shell's back gesture: window.flightEyeBack() answers true when the
  // page handled it; otherwise the shell leaves the app.
  const back = () => {
    const action = backAction({
      menuOpen: state.menuOpen,
      sheetExpanded: state.sheetExpanded,
      cockpitActive: cockpitState()?.active === true,
      panelOpen: byId('data-panel')?.classList.contains('active') === true,
    });
    if (action === 'close-menu') setMenuOpen(false);
    else if (action === 'collapse-sheet') {
      state.sheetExpanded = false;
      telemetry.dataset.expanded = 'false';
    } else if (action === 'exit-cockpit') styleManager.controlCockpit('exit');
    else if (action === 'close-panel')
      byId('data-panel')?.classList.remove('active');
    else return false;
    refresh();
    return true;
  };
  windowRef.flightEyeBack = back;

  const timer = setInterval(refresh, REFRESH_MS);
  refresh();

  return {
    refresh,
    back,
    destroy() {
      clearInterval(timer);
      listeners.abort();
      if (windowRef.flightEyeBack === back) delete windowRef.flightEyeBack;
      for (const node of [scrim, chips, telemetry, bar, menu]) node.remove();
      body.classList.remove('ui-phone');
      configureTrackingClickGesture();
    },
  };
}
