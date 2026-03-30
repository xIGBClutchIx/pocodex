import type {
  BrowserToServerEnvelope,
  SentryInitOptions,
  ServerToBrowserEnvelope,
} from "./protocol.js";
import { serializeInlineScript } from "./inline-script.js";

export interface BootstrapScriptConfig {
  sentryOptions: SentryInitOptions;
  stylesheetHref: string;
  importIconSvg?: string;
}

export function renderBootstrapScript(config: BootstrapScriptConfig): string {
  return serializeInlineScript(bootstrapPocodexInBrowser, config);
}

function bootstrapPocodexInBrowser(config: BootstrapScriptConfig): void {
  type ConnectionStatusOptions = {
    mode?: string;
  };

  type DesktopImportMode = "first-run" | "manual";

  type DesktopImportProject = {
    root: string;
    label: string;
    activeInCodex: boolean;
    alreadyImported: boolean;
    available: boolean;
  };

  type DesktopImportListResult = {
    found: boolean;
    path: string;
    promptSeen: boolean;
    shouldPrompt: boolean;
    projects: DesktopImportProject[];
  };

  type WorkspaceRootDialogMode = "add" | "pick";

  type WorkspaceRootAddResult = {
    success: boolean;
    root: string;
    error?: string;
  };

  type WorkspaceRootBrowserEntry = {
    name: string;
    path: string;
  };

  type WorkspaceRootBrowserResult = {
    root: string;
    parentRoot: string | null;
    homeDir: string;
    entries: WorkspaceRootBrowserEntry[];
  };

  type SessionValidationResult =
    | { ok: true }
    | { ok: false; reason: "unauthorized" | "unavailable" };

  type WorkerMessageListener = (message: unknown) => void;

  interface ElectronBridge {
    windowType: "electron";
    sendMessageFromView(message: unknown): Promise<void>;
    getPathForFile(): null;
    sendWorkerMessageFromView(workerName: string, message: unknown): Promise<void>;
    subscribeToWorkerMessages(workerName: string, callback: WorkerMessageListener): () => void;
    showContextMenu(): Promise<void>;
    getFastModeRolloutMetrics(): Promise<Record<string, never>>;
    triggerSentryTestError(): Promise<void>;
    getSentryInitOptions(): SentryInitOptions;
    getAppSessionId(): string;
    getBuildFlavor(): string;
  }

  const POCODEX_STYLESHEET_ID = "pocodex-stylesheet";
  const TOKEN_STORAGE_KEY = "__pocodex_token";
  const LAST_ROUTE_STORAGE_KEY = "__pocodex_last_route";
  const ENTER_BEHAVIOR_ATOM_KEY = "enter-behavior";
  const ENTER_BEHAVIOR_NEWLINE = "newline";
  const SOFT_KEYBOARD_INSET_THRESHOLD_PX = 120;
  const RETRY_DELAYS_MS = [1000, 2000, 5000] as const;
  const SESSION_CHECK_PATH = "/session-check";
  const MOBILE_SIDEBAR_MEDIA_QUERY = "(max-width: 640px), (pointer: coarse) and (max-width: 900px)";
  const NON_TEXT_INPUT_TYPES = new Set([
    "button",
    "checkbox",
    "color",
    "file",
    "hidden",
    "image",
    "radio",
    "range",
    "reset",
    "submit",
  ]);

  const workerSubscribers = new Map<string, Set<WorkerMessageListener>>();
  const pendingMessages: string[] = [];
  const toastHost = document.createElement("div");
  const statusHost = document.createElement("div");
  const importHost = document.createElement("div");

  let socket: WebSocket | null = null;
  let isConnecting = false;
  let reconnectAttempt = 0;
  let isClosing = false;
  let isOpenInAppObserverStarted = false;
  let isImportUiObserverStarted = false;
  let isEnterBehaviorOverrideObserverStarted = false;
  let hasConnected = false;
  let hasAttemptedDesktopImportPrompt = false;
  let hasSeenHostEnterBehavior = false;
  let hostEnterBehaviorDeleted = true;
  let hostEnterBehaviorValue: unknown = undefined;
  let hasDispatchedEnterBehavior = false;
  let dispatchedEnterBehaviorDeleted = true;
  let dispatchedEnterBehaviorValue: unknown = undefined;
  let nextIpcRequestId = 0;

  toastHost.id = "pocodex-toast-host";
  statusHost.id = "pocodex-status-host";
  importHost.id = "pocodex-import-host";
  importHost.hidden = true;
  document.documentElement.dataset.pocodex = "true";

  getStoredToken();
  restoreStoredRouteIfNeeded();
  installRoutePersistence();
  installEnterBehaviorOverrideObservers();

  runWhenDocumentReady(() => {
    ensureStylesheetLink(config.stylesheetHref);
    ensureHostAttached(toastHost);
    ensureHostAttached(statusHost);
    ensureHostAttached(importHost);
    startOpenInAppObserver();
    startImportUiObserver();
    installMobileSidebarThreadNavigationClose();
  });

  function runWhenDocumentReady(callback: () => void): void {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", callback, { once: true });
      return;
    }
    callback();
  }

  function ensureHostAttached(host: HTMLDivElement): void {
    if (!document.body) {
      runWhenDocumentReady(() => {
        ensureStylesheetLink(config.stylesheetHref);
        ensureHostAttached(host);
      });
      return;
    }
    if (!document.body.contains(host)) {
      document.body.appendChild(host);
    }
  }

  function ensureStylesheetLink(href?: string): HTMLLinkElement | null {
    const head = document.head ?? document.getElementsByTagName("head")[0];
    if (!head) {
      return null;
    }

    const current = document.getElementById(POCODEX_STYLESHEET_ID);
    let link = current instanceof HTMLLinkElement ? current : null;
    if (!link) {
      if (!href) {
        return null;
      }
      link = document.createElement("link");
      link.id = POCODEX_STYLESHEET_ID;
      link.rel = "stylesheet";
      head.appendChild(link);
    }

    if (href) {
      link.href = href;
    }

    return link;
  }

  function reloadStylesheet(href: string): void {
    const currentLink = ensureStylesheetLink();
    if (!currentLink) {
      ensureStylesheetLink(href);
      return;
    }

    const nextLink = document.createElement("link");
    nextLink.id = POCODEX_STYLESHEET_ID;
    nextLink.rel = "stylesheet";
    nextLink.href = href;
    nextLink.addEventListener(
      "load",
      () => {
        currentLink.remove();
      },
      { once: true },
    );
    nextLink.addEventListener(
      "error",
      () => {
        nextLink.remove();
        showNotice("Failed to reload Pocodex CSS.");
      },
      { once: true },
    );
    currentLink.after(nextLink);
  }

  function showNotice(message: string): void {
    const toast = document.createElement("div");
    toast.textContent = message;
    toast.dataset.pocodexToast = "true";
    ensureHostAttached(toastHost);
    toastHost.appendChild(toast);
    window.setTimeout(() => {
      toast.remove();
    }, 5000);
  }

  function setConnectionStatus(message: string, options: ConnectionStatusOptions = {}): void {
    ensureHostAttached(statusHost);
    statusHost.replaceChildren();
    statusHost.dataset.mode = options.mode ?? "blocking";
    statusHost.hidden = false;

    const card = document.createElement("div");
    card.dataset.pocodexStatusCard = "true";

    const title = document.createElement("strong");
    title.textContent = "Pocodex";

    const body = document.createElement("p");
    body.textContent = message;

    card.append(title, body);
    statusHost.appendChild(card);
  }

  function clearConnectionStatus(): void {
    statusHost.hidden = true;
    delete statusHost.dataset.mode;
    statusHost.replaceChildren();
  }

  function installMobileSidebarThreadNavigationClose(): void {
    document.addEventListener("click", handleMobileSidebarThreadClick, true);
    document.addEventListener("click", handleMobileContentPaneClick, true);
  }

  function handleMobileSidebarThreadClick(event: MouseEvent): void {
    if (!isMobileSidebarViewport() || !isPrimaryUnmodifiedClick(event)) {
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    if (!target) {
      return;
    }

    const navigation = target.closest('nav[role="navigation"]');
    if (!navigation) {
      return;
    }

    const nearestInteractive = target.closest(
      'button, a, input, select, textarea, [role="button"], [role="menuitem"]',
    );
    if (!nearestInteractive || !navigation.contains(nearestInteractive)) {
      return;
    }

    if (
      isMobileSidebarThreadRow(nearestInteractive) ||
      isMobileSidebarNewThreadTrigger(nearestInteractive)
    ) {
      scheduleMobileSidebarClose();
    }
  }

  function isMobileSidebarThreadRow(element: Element): boolean {
    if (
      element.tagName === "BUTTON" ||
      element.getAttribute("role") !== "button" ||
      !element.closest('nav[role="navigation"]')
    ) {
      return false;
    }

    if (element.querySelector("[data-thread-title]")) {
      return true;
    }

    if (!element.closest('[role="listitem"]')) {
      return false;
    }

    const buttons = element.querySelectorAll("button");
    for (let index = 0; index < buttons.length; index += 1) {
      const button = buttons.item(index);
      const ariaLabel = button?.getAttribute("aria-label");
      if (ariaLabel === "Archive thread" || ariaLabel === "Unarchive thread") {
        return true;
      }
    }

    return false;
  }

  function isMobileSidebarNewThreadTrigger(element: Element): boolean {
    if (
      !element.closest('nav[role="navigation"]') ||
      (element.tagName !== "BUTTON" && element.tagName !== "A")
    ) {
      return false;
    }

    const ariaLabel = element.getAttribute("aria-label")?.trim().toLowerCase() ?? "";
    if (ariaLabel === "new thread" || ariaLabel.startsWith("start new thread in ")) {
      return true;
    }

    const text = element.textContent?.trim().toLowerCase() ?? "";
    return text === "new thread";
  }

  function handleMobileContentPaneClick(event: MouseEvent): void {
    if (!isMobileSidebarViewport() || !isPrimaryUnmodifiedClick(event)) {
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    if (!target) {
      return;
    }

    if (target.closest('nav[role="navigation"]') || !target.closest(".main-surface")) {
      return;
    }

    if (!isMobileSidebarOpen()) {
      return;
    }

    scheduleMobileSidebarClose();
  }

  function scheduleMobileSidebarClose(): void {
    window.setTimeout(() => {
      if (isMobileSidebarViewport() && isMobileSidebarOpen()) {
        dispatchHostMessage({ type: "toggle-sidebar" });
      }
    }, 0);
  }

  function isMobileSidebarOpen(): boolean {
    const contentPane = document.querySelector(".main-surface");
    if (!(contentPane instanceof Element)) {
      return false;
    }

    const style = (
      contentPane as Element & {
        style?: { width?: string; transform?: string };
      }
    ).style;
    const width = typeof style?.width === "string" ? style.width.trim() : "";
    if (width !== "" && width !== "100%") {
      return true;
    }

    const transform = typeof style?.transform === "string" ? style.transform.trim() : "";
    if (transform !== "" && transform !== "translateX(0)" && transform !== "translateX(0px)") {
      return true;
    }

    return isMobileSidebarOpenByGeometry(contentPane);
  }

  function isMobileSidebarOpenByGeometry(contentPane: Element): boolean {
    if (typeof contentPane.getBoundingClientRect !== "function") {
      return false;
    }

    const viewportWidth = typeof window.innerWidth === "number" ? window.innerWidth : 0;
    const rect = contentPane.getBoundingClientRect();
    if (rect.left > 0.5) {
      return true;
    }

    if (viewportWidth > 0 && rect.width > 0 && rect.width < viewportWidth - 0.5) {
      return true;
    }

    const navigation = document.querySelector('nav[role="navigation"]');
    if (
      !(navigation instanceof Element) ||
      typeof navigation.getBoundingClientRect !== "function"
    ) {
      return false;
    }

    const navigationRect = navigation.getBoundingClientRect();
    return navigationRect.left >= -0.5 && navigationRect.right > 0.5 && navigationRect.width > 0.5;
  }

  function isMobileSidebarViewport(): boolean {
    if (typeof window.matchMedia === "function") {
      return window.matchMedia(MOBILE_SIDEBAR_MEDIA_QUERY).matches;
    }
    return window.innerWidth <= 640;
  }

  function isPrimaryUnmodifiedClick(event: MouseEvent): boolean {
    return (
      !event.defaultPrevented &&
      (event.button ?? 0) === 0 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey
    );
  }

  function isOpenInAppButtonGroup(group: HTMLDivElement): boolean {
    const buttons = group.querySelectorAll(":scope > button");
    if (buttons.length !== 2) {
      return false;
    }

    const primary = buttons.item(0);
    const secondary = buttons.item(1);
    if (!primary || !secondary) {
      return false;
    }

    return Boolean(
      primary.querySelector("img.icon-sm, img") &&
      secondary.getAttribute("aria-label") === "Secondary action" &&
      secondary.getAttribute("aria-haspopup") === "menu",
    );
  }

  function tagOpenInAppButtons(root: Document | Element = document): void {
    root.querySelectorAll("div.inline-flex").forEach((group) => {
      if (!(group instanceof HTMLDivElement)) {
        return;
      }
      if (isOpenInAppButtonGroup(group)) {
        group.dataset.pocodexOpenInApp = "true";
        return;
      }
      delete group.dataset.pocodexOpenInApp;
    });
  }

  function startOpenInAppObserver(): void {
    if (isOpenInAppObserverStarted || !document.body) {
      return;
    }

    isOpenInAppObserverStarted = true;
    tagOpenInAppButtons(document);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) {
            return;
          }
          tagOpenInAppButtons(node);
          if (node.parentElement) {
            tagOpenInAppButtons(node.parentElement);
          }
        });
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  function startImportUiObserver(): void {
    if (isImportUiObserverStarted || !document.body) {
      return;
    }

    isImportUiObserverStarted = true;
    refreshImportUi(document);

    const observer = new MutationObserver(() => {
      refreshImportUi(document);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function refreshImportUi(root: Document | Element = document): void {
    root.querySelectorAll('[role="menu"]').forEach((candidate) => {
      if (!(candidate instanceof Element)) {
        return;
      }
      maybeInjectSettingsMenuImportItem(candidate);
    });
  }

  function maybeInjectSettingsMenuImportItem(menu: Element): void {
    if (!looksLikeSettingsMenu(menu)) {
      return;
    }

    if (menu.querySelector('[data-pocodex-import-menu-item="true"]')) {
      return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.role = "menuitem";
    button.dataset.pocodexImportMenuItem = "true";
    const label = document.createElement("span");
    label.dataset.pocodexImportMenuLabel = "true";
    label.textContent = "Import from Codex.app";
    button.append(createImportMenuItemIcon(), label);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void openDesktopImportDialog("manual");
    });

    const separator = document.createElement("div");
    separator.role = "separator";
    separator.dataset.pocodexImportMenuSeparator = "true";

    menu.append(separator, button);
  }

  function createImportMenuItemIcon(): HTMLSpanElement {
    const icon = document.createElement("span");
    icon.dataset.pocodexImportMenuIcon = "true";
    if (config.importIconSvg) {
      icon.innerHTML = config.importIconSvg.trim();
    }
    return icon;
  }

  function looksLikeSettingsMenu(menu: Element): boolean {
    let hasSettingsItem = false;
    let hasLogOutItem = false;

    menu.querySelectorAll('[role="menuitem"]').forEach((item) => {
      if (!(item instanceof Element)) {
        return;
      }

      const text = item.textContent?.trim().toLowerCase() ?? "";
      if (text === "settings") {
        hasSettingsItem = true;
      }
      if (text === "log out") {
        hasLogOutItem = true;
      }
    });

    return hasSettingsItem && hasLogOutItem;
  }

  async function maybePromptForDesktopImport(): Promise<void> {
    if (hasAttemptedDesktopImportPrompt) {
      return;
    }

    hasAttemptedDesktopImportPrompt = true;
    await openDesktopImportDialog("first-run");
  }

  async function openDesktopImportDialog(mode: DesktopImportMode): Promise<void> {
    const result = await listDesktopImportProjects();
    if (!result) {
      return;
    }

    const importableProjects = result.projects.filter(
      (project) => project.available && !project.alreadyImported,
    );
    if (mode === "first-run" && !result.shouldPrompt) {
      return;
    }

    if (!result.found) {
      if (mode === "manual") {
        showNotice("Codex.app project state was not found.");
      }
      return;
    }

    if (importableProjects.length === 0) {
      if (mode === "manual") {
        showNotice("No additional Codex.app projects are available to import.");
      }
      return;
    }

    renderDesktopImportDialog(result, mode);
  }

  function renderDesktopImportDialog(
    result: DesktopImportListResult,
    mode: DesktopImportMode,
  ): void {
    ensureHostAttached(importHost);
    importHost.hidden = false;
    importHost.replaceChildren();

    const importableRoots = new Set(
      result.projects
        .filter((project) => project.available && !project.alreadyImported)
        .map((project) => project.root),
    );

    const backdrop = document.createElement("div");
    backdrop.dataset.pocodexImportBackdrop = "true";

    const dialog = document.createElement("section");
    dialog.dataset.pocodexImportDialog = "true";

    const header = document.createElement("div");
    header.dataset.pocodexImportHeader = "true";

    const title = document.createElement("h2");
    title.textContent = "Import projects from Codex.app";

    const subtitle = document.createElement("p");
    subtitle.textContent =
      mode === "first-run"
        ? "Choose which saved Codex.app projects you want to add to Pocodex."
        : "Select any additional Codex.app projects you want to bring into Pocodex.";

    header.append(title, subtitle);

    const list = document.createElement("div");
    list.dataset.pocodexImportList = "true";

    const selectedRoots = new Set<string>();
    const sortedProjects = [...result.projects].sort((left, right) => {
      if (left.activeInCodex !== right.activeInCodex) {
        return left.activeInCodex ? -1 : 1;
      }
      return left.label.localeCompare(right.label);
    });

    for (const project of sortedProjects) {
      const row = document.createElement("label");
      row.dataset.pocodexImportRow = "true";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = project.root;
      checkbox.disabled = !importableRoots.has(project.root);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          selectedRoots.add(project.root);
        } else {
          selectedRoots.delete(project.root);
        }
        importButton.disabled = selectedRoots.size === 0;
      });

      const details = document.createElement("div");
      details.dataset.pocodexImportDetails = "true";

      const label = document.createElement("strong");
      label.textContent = project.label;

      const root = document.createElement("code");
      root.textContent = formatDesktopImportPath(project.root);

      details.append(label, root);

      const badges = document.createElement("div");
      badges.dataset.pocodexImportBadges = "true";
      if (project.activeInCodex) {
        badges.appendChild(createDesktopImportBadge("Active in Codex.app"));
      }
      if (project.alreadyImported) {
        badges.appendChild(createDesktopImportBadge("Already in Pocodex"));
      } else if (!project.available) {
        badges.appendChild(createDesktopImportBadge("Missing on disk"));
      }

      row.append(checkbox, details);
      if (badges.childNodes.length > 0) {
        row.appendChild(badges);
      }
      list.appendChild(row);
    }

    const actions = document.createElement("div");
    actions.dataset.pocodexImportActions = "true";

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.textContent = mode === "first-run" ? "Skip for now" : "Cancel";
    cancelButton.addEventListener("click", () => {
      closeDesktopImportDialog(mode === "first-run");
    });

    const importButton = document.createElement("button");
    importButton.type = "button";
    importButton.dataset.variant = "primary";
    importButton.disabled = true;
    importButton.textContent = "Import selected";
    importButton.addEventListener("click", async () => {
      const roots = [...selectedRoots];
      if (roots.length === 0) {
        return;
      }

      importButton.disabled = true;
      cancelButton.disabled = true;
      importButton.textContent = "Importing...";

      try {
        const result = await callPocodexIpc("desktop-workspace-import/apply", {
          roots,
        });
        const importedRoots = getImportedRoots(result);
        closeDesktopImportDialog(false);
        if (importedRoots.length > 0) {
          showNotice(
            importedRoots.length === 1
              ? "Imported 1 project from Codex.app."
              : `Imported ${importedRoots.length} projects from Codex.app.`,
          );
        } else {
          showNotice("No new Codex.app projects were imported.");
        }
      } catch (error) {
        importButton.textContent = "Import selected";
        cancelButton.disabled = false;
        importButton.disabled = selectedRoots.size === 0;
        showNotice(
          error instanceof Error ? error.message : "Failed to import projects from Codex.app.",
        );
      }
    });

    actions.append(cancelButton, importButton);
    dialog.append(header, list, actions);
    backdrop.appendChild(dialog);
    backdrop.addEventListener("click", (event) => {
      if (event.target !== backdrop) {
        return;
      }
      closeDesktopImportDialog(mode === "first-run");
    });

    importHost.appendChild(backdrop);
  }

  function openWorkspaceRootDialog(mode: WorkspaceRootDialogMode): void {
    ensureHostAttached(importHost);
    importHost.hidden = false;
    importHost.replaceChildren();

    const backdrop = document.createElement("div");
    backdrop.dataset.pocodexImportBackdrop = "true";

    const dialog = document.createElement("section");
    dialog.dataset.pocodexImportDialog = "true";

    const header = document.createElement("div");
    header.dataset.pocodexImportHeader = "true";

    const title = document.createElement("h2");
    title.textContent = mode === "pick" ? "Open project folder" : "Add project folder";

    const subtitle = document.createElement("p");
    subtitle.textContent =
      mode === "pick"
        ? "Browse the host filesystem and open the current folder in Pocodex."
        : "Browse the host filesystem and add the current folder as another project in Pocodex.";

    header.append(title, subtitle);

    const browserShell = document.createElement("div");
    browserShell.dataset.pocodexWorkspaceBrowser = "true";

    const sidebar = document.createElement("aside");
    sidebar.dataset.pocodexWorkspaceSidebar = "true";

    const sidebarTitle = document.createElement("p");
    sidebarTitle.dataset.pocodexWorkspaceSidebarTitle = "true";
    sidebarTitle.textContent = "Folder tree";

    const tree = document.createElement("ul");
    tree.dataset.pocodexWorkspaceTree = "true";

    sidebar.append(sidebarTitle, tree);

    const mainPanel = document.createElement("section");
    mainPanel.dataset.pocodexWorkspaceMain = "true";

    const mobileLocation = document.createElement("div");
    mobileLocation.dataset.pocodexWorkspaceMobileLocation = "true";

    const mobileLocationSummary = document.createElement("div");
    mobileLocationSummary.dataset.pocodexWorkspaceMobileLocationSummary = "true";

    const mobileLocationName = document.createElement("strong");
    mobileLocationName.dataset.pocodexWorkspaceMobileLocationName = "true";

    const mobileLocationToggle = document.createElement("button");
    mobileLocationToggle.type = "button";
    mobileLocationToggle.dataset.pocodexWorkspaceMobileToggle = "true";

    mobileLocationSummary.append(mobileLocationName, mobileLocationToggle);

    const mobileLocationPath = document.createElement("div");
    mobileLocationPath.dataset.pocodexWorkspaceMobilePath = "true";

    const mobileLocationPathValue = document.createElement("code");

    const mobileLocationPathNav = document.createElement("div");
    mobileLocationPathNav.dataset.pocodexWorkspaceMobilePathNav = "true";

    const mobileUpButton = document.createElement("button");
    mobileUpButton.type = "button";
    mobileUpButton.dataset.pocodexWorkspaceNavButton = "true";
    mobileUpButton.textContent = "Up";

    const mobileBreadcrumb = document.createElement("nav");
    mobileBreadcrumb.dataset.pocodexWorkspaceBreadcrumb = "true";

    mobileLocationPathNav.append(mobileUpButton, mobileBreadcrumb);
    mobileLocationPath.append(mobileLocationPathValue, mobileLocationPathNav);
    mobileLocation.append(mobileLocationSummary, mobileLocationPath);

    const toolbar = document.createElement("div");
    toolbar.dataset.pocodexWorkspaceToolbar = "true";

    const upButton = document.createElement("button");
    upButton.type = "button";
    upButton.dataset.pocodexWorkspaceNavButton = "true";
    upButton.textContent = "Up";

    const breadcrumb = document.createElement("nav");
    breadcrumb.dataset.pocodexWorkspaceBreadcrumb = "true";

    toolbar.append(upButton, breadcrumb);

    const currentFolder = document.createElement("div");
    currentFolder.dataset.pocodexWorkspaceCurrent = "true";

    const currentFolderLabel = document.createElement("span");
    currentFolderLabel.textContent = "Current folder";

    const currentFolderPath = document.createElement("code");

    currentFolder.append(currentFolderLabel, currentFolderPath);

    const listHeader = document.createElement("div");
    listHeader.dataset.pocodexWorkspaceListHeader = "true";

    const listTitle = document.createElement("strong");
    listTitle.textContent = "Folders";

    const listMeta = document.createElement("span");

    listHeader.append(listTitle, listMeta);

    const listBody = document.createElement("div");
    listBody.dataset.pocodexWorkspaceList = "true";

    const status = document.createElement("p");
    status.dataset.pocodexWorkspaceStatus = "true";

    mainPanel.append(toolbar, currentFolder, listHeader, listBody, status);
    browserShell.append(sidebar, mainPanel);

    const actions = document.createElement("div");
    actions.dataset.pocodexImportActions = "true";

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.textContent = "Cancel";
    cancelButton.addEventListener("click", () => {
      closeImportOverlay();
    });

    const confirmButton = document.createElement("button");
    confirmButton.type = "button";
    confirmButton.dataset.variant = "primary";
    confirmButton.textContent = mode === "pick" ? "Open this folder" : "Add this folder";

    const directoryCache = new Map<string, WorkspaceRootBrowserResult>();
    const expandedRoots = new Set<string>();
    let treeRoot = "";
    let currentRoot = "";
    let homeDir = "";
    let loadingRoot = "";
    let isMobilePathExpanded = false;
    let isLoading = false;
    let loadError = "";

    const render = () => {
      const currentDirectory = currentRoot ? (directoryCache.get(currentRoot) ?? null) : null;
      const currentFolderLabel = getWorkspaceRootDisplayName(currentRoot, homeDir);
      currentFolderPath.textContent = currentRoot
        ? formatDesktopImportPath(currentRoot)
        : "Loading...";
      mobileLocationName.textContent = currentFolderLabel;
      mobileLocationPathValue.textContent = currentRoot
        ? formatDesktopImportPath(currentRoot)
        : "Loading...";
      mobileLocationToggle.textContent = isMobilePathExpanded ? "▴" : "▾";
      mobileLocationToggle.disabled = currentRoot.length === 0;
      mobileLocationToggle.setAttribute("aria-expanded", String(isMobilePathExpanded));
      mobileLocationToggle.setAttribute(
        "aria-label",
        isMobilePathExpanded ? "Hide full path navigation" : "Show full path navigation",
      );
      mobileLocationPath.hidden = !isMobilePathExpanded;
      confirmButton.disabled = isLoading || currentRoot.length === 0;
      upButton.disabled = isLoading || !currentDirectory?.parentRoot;
      mobileUpButton.disabled = upButton.disabled;
      listMeta.textContent =
        currentDirectory && currentDirectory.entries.length > 0
          ? `${currentDirectory.entries.length} folders`
          : "";

      renderWorkspaceRootBreadcrumbs(breadcrumb, currentRoot, homeDir, (root) => {
        void openDirectory(root);
      });
      renderWorkspaceRootBreadcrumbs(mobileBreadcrumb, currentRoot, homeDir, (root) => {
        void openDirectory(root);
        isMobilePathExpanded = false;
        render();
      });
      renderWorkspaceRootTree(tree, {
        treeRoot,
        currentRoot,
        homeDir,
        directoryCache,
        expandedRoots,
        onOpen(root) {
          void openDirectory(root);
        },
      });

      listBody.replaceChildren();
      status.hidden = true;
      status.textContent = "";

      if (loadError) {
        status.hidden = false;
        status.textContent = loadError;
        return;
      }

      if (isLoading && (!currentDirectory || loadingRoot === currentRoot)) {
        status.hidden = false;
        status.textContent = "Loading folders...";
        return;
      }

      if (!currentDirectory) {
        return;
      }

      if (currentDirectory.entries.length === 0) {
        status.hidden = false;
        status.textContent = "No folders are available here.";
        return;
      }

      for (const entry of currentDirectory.entries) {
        const row = document.createElement("button");
        row.type = "button";
        row.dataset.pocodexWorkspaceEntry = "true";

        const entryName = document.createElement("strong");
        entryName.textContent = entry.name;

        const entryPath = document.createElement("span");
        entryPath.textContent = formatDesktopImportPath(entry.path);

        row.append(entryName, entryPath);
        row.addEventListener("click", () => {
          void openDirectory(entry.path);
        });
        listBody.appendChild(row);
      }
    };

    const openDirectory = async (root?: string): Promise<void> => {
      isLoading = true;
      loadError = "";
      loadingRoot = root ?? "";
      render();

      try {
        const result = await listWorkspaceRootBrowserFromHost(root);
        directoryCache.set(result.root, result);
        currentRoot = result.root;
        homeDir = result.homeDir;
        expandedRoots.add(result.root);
        if (!treeRoot || !isWorkspaceRootPathWithin(treeRoot, result.root)) {
          treeRoot = result.root;
        }
        isLoading = false;
        loadingRoot = "";
        render();
      } catch (error) {
        isLoading = false;
        loadingRoot = "";
        loadError =
          error instanceof Error
            ? error.message
            : "Failed to load folders from the host filesystem.";
        render();
      }
    };

    const submit = async () => {
      if (!currentRoot) {
        return;
      }

      confirmButton.disabled = true;
      cancelButton.disabled = true;
      confirmButton.textContent = mode === "pick" ? "Opening..." : "Adding...";

      try {
        const result = await addWorkspaceRootFromHost({
          root: currentRoot,
          setActive: mode === "pick",
        });
        if (!result.success) {
          throw new Error(result.error || "Failed to add project from the host filesystem.");
        }

        closeImportOverlay();
        dispatchHostMessage({
          type: mode === "pick" ? "workspace-root-option-picked" : "workspace-root-option-added",
          root: result.root,
        });
        showNotice(
          mode === "pick"
            ? "Opened project from the host filesystem."
            : "Added project from the host filesystem.",
        );
      } catch (error) {
        confirmButton.textContent = mode === "pick" ? "Open this folder" : "Add this folder";
        cancelButton.disabled = false;
        confirmButton.disabled = currentRoot.length === 0;
        showNotice(
          error instanceof Error
            ? error.message
            : "Failed to add project from the host filesystem.",
        );
      }
    };

    upButton.addEventListener("click", () => {
      const currentDirectory = currentRoot ? (directoryCache.get(currentRoot) ?? null) : null;
      if (currentDirectory?.parentRoot) {
        void openDirectory(currentDirectory.parentRoot);
      }
    });
    mobileUpButton.addEventListener("click", () => {
      const currentDirectory = currentRoot ? (directoryCache.get(currentRoot) ?? null) : null;
      if (currentDirectory?.parentRoot) {
        isMobilePathExpanded = false;
        void openDirectory(currentDirectory.parentRoot);
      }
    });
    mobileLocationToggle.addEventListener("click", () => {
      if (!currentRoot) {
        return;
      }
      isMobilePathExpanded = !isMobilePathExpanded;
      render();
    });
    confirmButton.addEventListener("click", () => {
      void submit();
    });

    actions.append(cancelButton, confirmButton);
    mainPanel.prepend(mobileLocation);
    dialog.append(header, browserShell, actions);
    backdrop.appendChild(dialog);
    backdrop.addEventListener("click", (event) => {
      if (event.target !== backdrop) {
        return;
      }
      closeImportOverlay();
    });

    importHost.appendChild(backdrop);
    render();
    void openDirectory();
  }

  function formatDesktopImportPath(path: string): string {
    const trimmedPath = path.trim();
    if (trimmedPath.length === 0) {
      return path;
    }

    return trimmedPath.replace(/^\/(?:users|home)\/[^/]+(?=\/|$)/i, "~");
  }

  function getWorkspaceRootDisplayName(root: string, homeDir: string): string {
    if (!root) {
      return "Loading...";
    }

    const normalizedRoot = normalizeWorkspaceRootBrowserPath(root);
    if (normalizedRoot === "/") {
      return "/";
    }
    if (normalizedRoot === homeDir) {
      return "~";
    }

    const parts = normalizedRoot.split("/").filter((part) => part.length > 0);
    return parts.at(-1) ?? normalizedRoot;
  }

  function createDesktopImportBadge(text: string): HTMLSpanElement {
    const badge = document.createElement("span");
    badge.dataset.pocodexImportBadge = "true";
    badge.textContent = text;
    return badge;
  }

  function closeDesktopImportDialog(markPromptSeen: boolean): void {
    closeImportOverlay();
    if (markPromptSeen) {
      void dismissDesktopImportPrompt();
    }
  }

  function closeImportOverlay(): void {
    importHost.hidden = true;
    importHost.replaceChildren();
  }

  async function dismissDesktopImportPrompt(): Promise<void> {
    try {
      await callPocodexIpc("desktop-workspace-import/dismiss");
    } catch (error) {
      showNotice(
        error instanceof Error ? error.message : "Failed to dismiss the Codex.app import prompt.",
      );
    }
  }

  async function listDesktopImportProjects(): Promise<DesktopImportListResult | null> {
    try {
      const result = await callPocodexIpc("desktop-workspace-import/list");
      return isDesktopImportListResult(result) ? result : null;
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Failed to load Codex.app projects.");
      return null;
    }
  }

  async function callPocodexIpc(method: string, params?: unknown): Promise<unknown> {
    const response = await nativeFetch("/ipc-request", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      cache: "no-store",
      credentials: "same-origin",
      body: JSON.stringify({
        requestId: `pocodex-ipc-${++nextIpcRequestId}`,
        method,
        params,
      }),
    });
    const payload = (await response.json()) as unknown;
    if (!isRecord(payload) || payload.resultType !== "success") {
      const error =
        isRecord(payload) && typeof payload.error === "string"
          ? payload.error
          : `IPC request failed (${response.status}).`;
      throw new Error(error);
    }

    return payload.result;
  }

  function getImportedRoots(result: unknown): string[] {
    if (!isRecord(result) || !Array.isArray(result.importedRoots)) {
      return [];
    }

    return result.importedRoots.filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
  }

  async function addWorkspaceRootFromHost(params: {
    root: string;
    setActive: boolean;
  }): Promise<WorkspaceRootAddResult> {
    const result = await callPocodexIpc("workspace-root-option/add", params);
    if (!isWorkspaceRootAddResult(result)) {
      throw new Error("Pocodex returned an invalid workspace-root response.");
    }
    return result;
  }

  async function listWorkspaceRootBrowserFromHost(
    root?: string,
  ): Promise<WorkspaceRootBrowserResult> {
    const result = await callPocodexIpc("workspace-root-browser/list", root ? { root } : undefined);
    if (!isWorkspaceRootBrowserResult(result)) {
      throw new Error("Pocodex returned an invalid workspace-root browser response.");
    }
    return result;
  }

  function isDesktopImportListResult(value: unknown): value is DesktopImportListResult {
    return (
      isRecord(value) &&
      typeof value.found === "boolean" &&
      typeof value.path === "string" &&
      typeof value.promptSeen === "boolean" &&
      typeof value.shouldPrompt === "boolean" &&
      Array.isArray(value.projects)
    );
  }

  function isWorkspaceRootAddResult(value: unknown): value is WorkspaceRootAddResult {
    return (
      isRecord(value) &&
      typeof value.success === "boolean" &&
      typeof value.root === "string" &&
      (value.error === undefined || typeof value.error === "string")
    );
  }

  function isWorkspaceRootBrowserResult(value: unknown): value is WorkspaceRootBrowserResult {
    return (
      isRecord(value) &&
      typeof value.root === "string" &&
      (value.parentRoot === null || typeof value.parentRoot === "string") &&
      typeof value.homeDir === "string" &&
      Array.isArray(value.entries) &&
      value.entries.every(
        (entry) =>
          isRecord(entry) && typeof entry.name === "string" && typeof entry.path === "string",
      )
    );
  }

  function renderWorkspaceRootBreadcrumbs(
    host: HTMLElement,
    currentRoot: string,
    homeDir: string,
    onOpen: (root: string) => void,
  ): void {
    host.replaceChildren();
    if (!currentRoot) {
      return;
    }

    const segments = getWorkspaceRootPathSegments(currentRoot, homeDir);
    for (const segment of segments) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = segment.label;
      button.addEventListener("click", () => {
        onOpen(segment.path);
      });
      host.appendChild(button);
    }
  }

  function getWorkspaceRootPathSegments(
    root: string,
    homeDir: string,
  ): Array<{ label: string; path: string }> {
    const normalized = normalizeWorkspaceRootBrowserPath(root);
    if (normalized === "/") {
      return [{ label: "/", path: "/" }];
    }

    const parts = normalized.split("/").filter((part) => part.length > 0);
    const segments: Array<{ label: string; path: string }> = [];
    let current = "";
    for (const part of parts) {
      current += `/${part}`;
      segments.push({
        label: current === homeDir ? "~" : part,
        path: current,
      });
    }
    return segments;
  }

  function renderWorkspaceRootTree(
    host: HTMLElement,
    options: {
      treeRoot: string;
      currentRoot: string;
      homeDir: string;
      directoryCache: Map<string, WorkspaceRootBrowserResult>;
      expandedRoots: Set<string>;
      onOpen: (root: string) => void;
    },
  ): void {
    host.replaceChildren();
    if (!options.treeRoot) {
      return;
    }

    host.appendChild(
      createWorkspaceRootTreeItem(options.treeRoot, {
        currentRoot: options.currentRoot,
        homeDir: options.homeDir,
        directoryCache: options.directoryCache,
        expandedRoots: options.expandedRoots,
        onOpen: options.onOpen,
      }),
    );
  }

  function createWorkspaceRootTreeItem(
    root: string,
    options: {
      currentRoot: string;
      homeDir: string;
      directoryCache: Map<string, WorkspaceRootBrowserResult>;
      expandedRoots: Set<string>;
      onOpen: (root: string) => void;
    },
  ): HTMLLIElement {
    const item = document.createElement("li");
    item.dataset.pocodexWorkspaceTreeItem = "true";

    const button = document.createElement("button");
    button.type = "button";
    button.dataset.pocodexWorkspaceTreeButton = "true";
    if (root === options.currentRoot) {
      button.dataset.current = "true";
    }

    const isExpanded = options.expandedRoots.has(root);
    const currentDirectory = options.directoryCache.get(root);

    const caret = document.createElement("span");
    caret.dataset.pocodexWorkspaceTreeCaret = "true";
    caret.textContent = isExpanded && currentDirectory ? "▾" : "▸";

    const label = document.createElement("span");
    label.textContent = getWorkspaceRootTreeLabel(root, options.homeDir);

    button.append(caret, label);
    button.addEventListener("click", () => {
      options.expandedRoots.add(root);
      options.onOpen(root);
    });

    item.appendChild(button);

    if (isExpanded && currentDirectory && currentDirectory.entries.length > 0) {
      const subtree = document.createElement("ul");
      subtree.dataset.pocodexWorkspaceTree = "true";
      for (const entry of currentDirectory.entries) {
        if (
          !options.expandedRoots.has(entry.path) &&
          entry.path !== options.currentRoot &&
          !isWorkspaceRootPathWithin(entry.path, options.currentRoot)
        ) {
          continue;
        }
        subtree.appendChild(
          createWorkspaceRootTreeItem(entry.path, {
            currentRoot: options.currentRoot,
            homeDir: options.homeDir,
            directoryCache: options.directoryCache,
            expandedRoots: options.expandedRoots,
            onOpen: options.onOpen,
          }),
        );
      }
      if (subtree.childNodes.length > 0) {
        item.appendChild(subtree);
      }
    }

    return item;
  }

  function getWorkspaceRootTreeLabel(root: string, homeDir: string): string {
    if (root === homeDir) {
      return "~";
    }

    const normalized = normalizeWorkspaceRootBrowserPath(root);
    if (normalized === "/") {
      return "/";
    }

    const parts = normalized.split("/").filter((part) => part.length > 0);
    return parts.at(-1) ?? normalized;
  }

  function isWorkspaceRootPathWithin(parent: string, child: string): boolean {
    const normalizedParent = normalizeWorkspaceRootBrowserPath(parent);
    const normalizedChild = normalizeWorkspaceRootBrowserPath(child);
    if (normalizedParent === "/") {
      return normalizedChild.startsWith("/");
    }
    return (
      normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`)
    );
  }

  function normalizeWorkspaceRootBrowserPath(path: string): string {
    if (!path) {
      return "/";
    }

    return path.length > 1 ? path.replace(/\/+$/, "") : path;
  }

  function dispatchHostMessage(message: unknown): void {
    window.dispatchEvent(new MessageEvent("message", { data: message }));
  }

  function installEnterBehaviorOverrideObservers(): void {
    if (isEnterBehaviorOverrideObserverStarted) {
      return;
    }

    isEnterBehaviorOverrideObserverStarted = true;
    document.addEventListener("focusin", refreshEffectiveEnterBehavior, true);
    document.addEventListener("focusout", refreshEffectiveEnterBehavior, true);
    window.addEventListener("resize", refreshEffectiveEnterBehavior);
    window.visualViewport?.addEventListener("resize", refreshEffectiveEnterBehavior);
  }

  function rewriteBridgeMessageForLocalOverrides(message: unknown): unknown {
    rememberHostEnterBehavior(message);

    if (!isRecord(message) || typeof message.type !== "string") {
      return message;
    }

    const overriddenMessage = overrideEnterBehaviorInMessage(message);
    rememberDispatchedEnterBehavior(overriddenMessage);
    return overriddenMessage;
  }

  function overrideEnterBehaviorInMessage(message: Record<string, unknown>): unknown {
    if (!shouldForceNewlineEnterBehavior()) {
      return message;
    }

    if (message.type === "persisted-atom-sync") {
      const state = isRecord(message.state) ? { ...message.state } : {};
      state[ENTER_BEHAVIOR_ATOM_KEY] = ENTER_BEHAVIOR_NEWLINE;
      return {
        ...message,
        state,
      };
    }

    if (message.type === "persisted-atom-updated" && message.key === ENTER_BEHAVIOR_ATOM_KEY) {
      return {
        ...message,
        value: ENTER_BEHAVIOR_NEWLINE,
        deleted: false,
      };
    }

    return message;
  }

  function rememberHostEnterBehavior(message: unknown): void {
    const state = getEnterBehaviorStateFromMessage(message);
    if (!state) {
      return;
    }

    hasSeenHostEnterBehavior = true;
    hostEnterBehaviorDeleted = state.deleted;
    hostEnterBehaviorValue = state.value;
  }

  function rememberDispatchedEnterBehavior(message: unknown): void {
    const state = getEnterBehaviorStateFromMessage(message);
    if (!state) {
      return;
    }

    hasDispatchedEnterBehavior = true;
    dispatchedEnterBehaviorDeleted = state.deleted;
    dispatchedEnterBehaviorValue = state.value;
  }

  function getEnterBehaviorStateFromMessage(
    message: unknown,
  ): { deleted: boolean; value: unknown } | null {
    if (!isRecord(message) || typeof message.type !== "string") {
      return null;
    }

    if (message.type === "persisted-atom-sync") {
      const state = isRecord(message.state) ? message.state : null;
      if (state && Object.prototype.hasOwnProperty.call(state, ENTER_BEHAVIOR_ATOM_KEY)) {
        return {
          deleted: false,
          value: state[ENTER_BEHAVIOR_ATOM_KEY],
        };
      }

      return {
        deleted: true,
        value: undefined,
      };
    }

    if (
      message.type === "persisted-atom-updated" &&
      typeof message.key === "string" &&
      message.key === ENTER_BEHAVIOR_ATOM_KEY
    ) {
      return {
        deleted: message.deleted === true,
        value: message.value,
      };
    }

    return null;
  }

  function refreshEffectiveEnterBehavior(): void {
    if (!hasSeenHostEnterBehavior) {
      return;
    }

    const next = getEffectiveEnterBehaviorState();
    if (
      hasDispatchedEnterBehavior &&
      dispatchedEnterBehaviorDeleted === next.deleted &&
      Object.is(dispatchedEnterBehaviorValue, next.value)
    ) {
      return;
    }

    hasDispatchedEnterBehavior = true;
    dispatchedEnterBehaviorDeleted = next.deleted;
    dispatchedEnterBehaviorValue = next.value;
    dispatchHostMessage({
      type: "persisted-atom-updated",
      key: ENTER_BEHAVIOR_ATOM_KEY,
      value: next.value,
      deleted: next.deleted,
    });
  }

  function getEffectiveEnterBehaviorState(): { deleted: boolean; value: unknown } {
    if (shouldForceNewlineEnterBehavior()) {
      return {
        deleted: false,
        value: ENTER_BEHAVIOR_NEWLINE,
      };
    }

    return {
      deleted: hostEnterBehaviorDeleted,
      value: hostEnterBehaviorValue,
    };
  }

  function shouldForceNewlineEnterBehavior(): boolean {
    if (!isTextEntryFocused()) {
      return false;
    }

    const keyboardInset = getSoftKeyboardViewportInset();
    if (keyboardInset !== null) {
      return keyboardInset >= SOFT_KEYBOARD_INSET_THRESHOLD_PX;
    }

    return supportsTouchInput();
  }

  function getSoftKeyboardViewportInset(): number | null {
    const visualViewport = window.visualViewport;
    if (!visualViewport || typeof visualViewport.height !== "number") {
      return null;
    }

    const layoutViewportHeight = typeof window.innerHeight === "number" ? window.innerHeight : 0;
    if (layoutViewportHeight <= 0) {
      return null;
    }

    return Math.max(0, layoutViewportHeight - visualViewport.height);
  }

  function supportsTouchInput(): boolean {
    if (typeof navigator !== "undefined" && typeof navigator.maxTouchPoints === "number") {
      if (navigator.maxTouchPoints > 0) {
        return true;
      }
    }

    if (typeof window.matchMedia === "function") {
      return window.matchMedia("(pointer: coarse)").matches;
    }

    return false;
  }

  function isTextEntryFocused(): boolean {
    const activeElement = document.activeElement;
    return activeElement instanceof Element && isTextEntryElement(activeElement);
  }

  function isTextEntryElement(element: Element): boolean {
    if (element.tagName === "TEXTAREA") {
      return true;
    }

    const contentEditable = element.getAttribute("contenteditable");
    if (contentEditable === "" || contentEditable === "true") {
      return true;
    }

    if (element.tagName !== "INPUT") {
      return false;
    }

    const inputType = element.getAttribute("type")?.trim().toLowerCase() ?? "text";
    return !NON_TEXT_INPUT_TYPES.has(inputType);
  }

  function handlePocodexBridgeMessage(message: unknown): boolean {
    if (!isRecord(message) || typeof message.type !== "string") {
      return false;
    }

    if (message.type === "pocodex-open-desktop-import-dialog") {
      const mode = message.mode === "first-run" ? "first-run" : "manual";
      void openDesktopImportDialog(mode);
      return true;
    }

    if (message.type === "pocodex-open-workspace-root-dialog") {
      const mode = message.mode === "pick" ? "pick" : "add";
      openWorkspaceRootDialog(mode);
      return true;
    }

    return false;
  }

  function getStoredToken(): string {
    const url = new URL(window.location.href);
    const tokenFromQuery = url.searchParams.get("token");
    if (tokenFromQuery) {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, tokenFromQuery);
      return tokenFromQuery;
    }
    return sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
  }

  function restoreStoredRouteIfNeeded(): void {
    const currentUrl = new URL(window.location.href);
    if (currentUrl.pathname !== "/" && currentUrl.pathname !== "/index.html") {
      return;
    }

    const storedRoute = readSessionStorage(LAST_ROUTE_STORAGE_KEY);
    if (!storedRoute) {
      return;
    }

    try {
      window.history.replaceState(null, "", storedRoute);
    } catch {
      // Ignore history update failures and keep the current route.
    }
  }

  function installRoutePersistence(): void {
    const historyObject = window.history;
    if (!historyObject) {
      return;
    }

    const originalPushState =
      typeof historyObject.pushState === "function"
        ? historyObject.pushState.bind(historyObject)
        : null;
    const originalReplaceState =
      typeof historyObject.replaceState === "function"
        ? historyObject.replaceState.bind(historyObject)
        : null;

    if (originalPushState) {
      historyObject.pushState = (data, unused, url) => {
        originalPushState(data, unused, url);
        persistCurrentRoute();
      };
    }

    if (originalReplaceState) {
      historyObject.replaceState = (data, unused, url) => {
        originalReplaceState(data, unused, url);
        persistCurrentRoute();
      };
    }

    window.addEventListener("popstate", persistCurrentRoute);
    window.addEventListener("hashchange", persistCurrentRoute);
    persistCurrentRoute();
  }

  function persistCurrentRoute(): void {
    writeSessionStorage(LAST_ROUTE_STORAGE_KEY, buildRestorableRoute(window.location.href));
  }

  function buildRestorableRoute(href: string): string {
    const url = new URL(href);
    url.searchParams.delete("token");
    const route = `${url.pathname}${url.search}${url.hash}`;
    return route.length > 0 ? route : "/";
  }

  function readSessionStorage(key: string): string | null {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeSessionStorage(key: string, value: string): void {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      // Ignore storage failures when persistence is unavailable.
    }
  }

  function getSocketUrl(token: string): string {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = new URL(`${protocol}//${window.location.host}/session`);
    if (token) {
      url.searchParams.set("token", token);
    }
    return url.toString();
  }

  function getSessionCheckUrl(token: string): string {
    const url = new URL(SESSION_CHECK_PATH, window.location.href);
    if (token) {
      url.searchParams.set("token", token);
    }
    return `${url.pathname}${url.search}`;
  }

  async function validateSessionToken(token: string): Promise<SessionValidationResult> {
    try {
      const response = await window.fetch(getSessionCheckUrl(token), {
        cache: "no-store",
        credentials: "same-origin",
      });

      if (response.ok) {
        return { ok: true };
      }
      if (response.status === 401) {
        return { ok: false, reason: "unauthorized" };
      }
      return { ok: false, reason: "unavailable" };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  }

  function scheduleReconnect(message: string): void {
    const delay = RETRY_DELAYS_MS[Math.min(reconnectAttempt, RETRY_DELAYS_MS.length - 1)];
    reconnectAttempt += 1;
    setConnectionStatus(message);
    window.setTimeout(() => {
      void connectSocket();
    }, delay);
  }

  function flushPendingMessages(): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    while (pendingMessages.length > 0) {
      const message = pendingMessages.shift();
      if (message === undefined) {
        return;
      }
      socket.send(message);
    }
  }

  function sendEnvelope(envelope: BrowserToServerEnvelope): void {
    const serialized = JSON.stringify(envelope);
    if (!socket) {
      pendingMessages.push(serialized);
      void connectSocket();
      return;
    }
    if (socket.readyState === WebSocket.CONNECTING) {
      pendingMessages.push(serialized);
      return;
    }
    if (socket.readyState !== WebSocket.OPEN) {
      pendingMessages.push(serialized);
      void connectSocket();
      return;
    }
    socket.send(serialized);
  }

  function publishFocusState(): void {
    sendEnvelope({
      type: "focus_state",
      isFocused: document.visibilityState === "visible" && document.hasFocus(),
    });
  }

  async function connectSocket(): Promise<void> {
    const isSocketActive =
      socket !== null &&
      (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING);
    if (isClosing || isConnecting || isSocketActive) {
      return;
    }

    const token = getStoredToken();
    isConnecting = true;
    setConnectionStatus(hasConnected ? "Reconnecting to Pocodex..." : "Connecting to Pocodex...");

    const validation = await validateSessionToken(token);
    if (!validation.ok) {
      isConnecting = false;
      if (validation.reason === "unauthorized") {
        setConnectionStatus(
          token
            ? "Pocodex rejected this token. Open the exact URL printed by the CLI for the current run."
            : "Pocodex requires a token. Open the exact URL printed by the CLI for the current run.",
        );
        return;
      }
      scheduleReconnect("Pocodex is unavailable. Retrying...");
      return;
    }

    socket = new WebSocket(getSocketUrl(token));
    socket.addEventListener("open", () => {
      isConnecting = false;
      reconnectAttempt = 0;
      const shouldReload = hasConnected;
      hasConnected = true;
      clearConnectionStatus();
      flushPendingMessages();
      publishFocusState();
      for (const workerName of workerSubscribers.keys()) {
        sendEnvelope({ type: "worker_subscribe", workerName });
      }
      if (!shouldReload) {
        window.setTimeout(() => {
          void maybePromptForDesktopImport();
        }, 250);
      }
      if (shouldReload) {
        window.location.reload();
      }
    });

    socket.addEventListener("error", () => {
      if (!hasConnected) {
        setConnectionStatus(
          "Pocodex could not open its live session. Check the CLI output and the page token.",
        );
      }
    });

    socket.addEventListener("message", (event) => {
      const envelope = parseServerEnvelope(event.data);
      if (!envelope) {
        showNotice("Pocodex received invalid server data.");
        return;
      }

      switch (envelope.type) {
        case "bridge_message":
          {
            const bridgeMessage = rewriteBridgeMessageForLocalOverrides(envelope.message);
            if (handlePocodexBridgeMessage(bridgeMessage)) {
              break;
            }
            dispatchHostMessage(bridgeMessage);
          }
          break;
        case "worker_message": {
          const listeners = workerSubscribers.get(envelope.workerName);
          listeners?.forEach((listener) => listener(envelope.message));
          break;
        }
        case "client_notice":
          showNotice(envelope.message);
          break;
        case "css_reload":
          reloadStylesheet(envelope.href);
          break;
        case "session_revoked":
          showNotice(envelope.reason || "This Pocodex session is no longer available.");
          setConnectionStatus(envelope.reason || "This Pocodex session is no longer available.");
          isClosing = true;
          socket?.close(4001, "revoked");
          break;
        case "error":
          showNotice(envelope.message);
          break;
      }
    });

    socket.addEventListener("close", () => {
      const shouldReconnect = !isClosing;
      socket = null;
      isConnecting = false;
      if (!shouldReconnect) {
        return;
      }
      showNotice("Pocodex lost the host connection. Retrying...");
      scheduleReconnect("Pocodex lost the host connection. Retrying...");
    });
  }

  function parseServerEnvelope(data: unknown): ServerToBrowserEnvelope | null {
    try {
      const parsed = JSON.parse(String(data)) as unknown;
      return isServerToBrowserEnvelope(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function isServerToBrowserEnvelope(value: unknown): value is ServerToBrowserEnvelope {
    if (!isRecord(value) || typeof value.type !== "string") {
      return false;
    }

    switch (value.type) {
      case "bridge_message":
        return "message" in value;
      case "worker_message":
        return typeof value.workerName === "string" && "message" in value;
      case "client_notice":
        return typeof value.message === "string";
      case "css_reload":
        return typeof value.href === "string";
      case "session_revoked":
        return typeof value.reason === "string";
      case "error":
        return typeof value.message === "string";
      default:
        return false;
    }
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  function addWorkerSubscriber(workerName: string, callback: WorkerMessageListener): () => void {
    let listeners = workerSubscribers.get(workerName);
    if (!listeners) {
      listeners = new Set<WorkerMessageListener>();
      workerSubscribers.set(workerName, listeners);
      sendEnvelope({ type: "worker_subscribe", workerName });
    }

    listeners.add(callback);
    return () => {
      const currentListeners = workerSubscribers.get(workerName);
      if (!currentListeners) {
        return;
      }
      currentListeners.delete(callback);
      if (currentListeners.size === 0) {
        workerSubscribers.delete(workerName);
        sendEnvelope({ type: "worker_unsubscribe", workerName });
      }
    };
  }

  const electronBridge: ElectronBridge = {
    windowType: "electron",
    sendMessageFromView: async (message) => {
      if (isRecord(message) && message.type === "electron-window-focus-request") {
        dispatchHostMessage({
          type: "electron-window-focus-changed",
          isFocused: document.visibilityState === "visible" && document.hasFocus(),
        });
        return;
      }
      sendEnvelope({ type: "bridge_message", message });
    },
    getPathForFile: () => null,
    sendWorkerMessageFromView: async (workerName, message) => {
      sendEnvelope({ type: "worker_message", workerName, message });
    },
    subscribeToWorkerMessages: (workerName, callback) => addWorkerSubscriber(workerName, callback),
    showContextMenu: async () => {
      showNotice("Context menus are not available in Pocodex.");
    },
    getFastModeRolloutMetrics: async () => ({}),
    triggerSentryTestError: async () => {},
    getSentryInitOptions: () => config.sentryOptions,
    getAppSessionId: () => config.sentryOptions.codexAppSessionId,
    getBuildFlavor: () => config.sentryOptions.buildFlavor,
  };

  const nativeFetch: typeof window.fetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    if (url.startsWith("sentry-ipc://")) {
      return Promise.resolve(
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (url === "vscode://codex/ipc-request") {
      const method =
        init?.method ??
        (input instanceof Request ? (input as Request & { method?: string }).method : undefined) ??
        "POST";
      return nativeFetch("/ipc-request", {
        method,
        body: init?.body,
        headers: init?.headers,
        cache: "no-store",
        credentials: "same-origin",
      });
    }
    return nativeFetch(input, init);
  };

  Object.defineProperty(window, "codexWindowType", {
    value: "electron",
    configurable: false,
    enumerable: true,
    writable: false,
  });
  Object.defineProperty(window, "electronBridge", {
    value: electronBridge,
    configurable: false,
    enumerable: true,
    writable: false,
  });

  window.addEventListener("focus", publishFocusState);
  window.addEventListener("blur", publishFocusState);
  document.addEventListener("visibilitychange", publishFocusState);
  window.addEventListener(
    "beforeunload",
    () => {
      isClosing = true;
      if (socket) {
        socket.close(1000, "unload");
      }
    },
    { once: true },
  );

  void connectSocket();
}
