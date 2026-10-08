const READ_TOKEN_STORAGE_KEY = "fluxscale.dashboard.read-token.v1";
const MIN_TOKEN_LENGTH = 32;
const MAX_TOKEN_LENGTH = 512;

let memoryToken: string | null = null;
let storageLoaded = false;

function sessionStore(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function loadStoredToken(): string | null {
  if (storageLoaded) {
    return memoryToken;
  }

  storageLoaded = true;
  const store = sessionStore();

  if (!store) {
    return memoryToken;
  }

  try {
    const value = store.getItem(READ_TOKEN_STORAGE_KEY);
    memoryToken = value && validTokenShape(value) ? value : null;

    if (value && !memoryToken) {
      store.removeItem(READ_TOKEN_STORAGE_KEY);
    }
  } catch {
    memoryToken = null;
  }

  return memoryToken;
}

function validTokenShape(token: string): boolean {
  return (
    token.length >= MIN_TOKEN_LENGTH &&
    token.length <= MAX_TOKEN_LENGTH &&
    !/\s/.test(token)
  );
}

export function validateDashboardReadToken(token: string): string {
  if (!validTokenShape(token)) {
    throw new Error(
      `Read token must contain ${MIN_TOKEN_LENGTH}-${MAX_TOKEN_LENGTH} characters without whitespace.`,
    );
  }

  return token;
}

export function getDashboardReadToken(): string | null {
  return loadStoredToken();
}

export function hasDashboardReadToken(): boolean {
  return getDashboardReadToken() !== null;
}

export function saveDashboardReadToken(token: string): void {
  const validated = validateDashboardReadToken(token);
  memoryToken = validated;
  storageLoaded = true;

  const store = sessionStore();

  if (!store) {
    return;
  }

  try {
    store.setItem(READ_TOKEN_STORAGE_KEY, validated);
  } catch {
    // The in-memory session remains usable when browser storage is unavailable.
  }
}

export function clearDashboardReadToken(): void {
  memoryToken = null;
  storageLoaded = true;

  const store = sessionStore();

  if (!store) {
    return;
  }

  try {
    store.removeItem(READ_TOKEN_STORAGE_KEY);
  } catch {
    // Clearing the in-memory copy is sufficient for the active page.
  }
}
