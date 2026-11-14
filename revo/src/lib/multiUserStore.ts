import path from 'path';
import { getDataDir, readDataFileAsync, writeDataFileAsync } from './dataStore';
import {
  decryptCredential,
  encryptCredential,
  isCryptoVaultConfigured,
  loadServerCryptoVault,
} from './cryptoVault';
import { stateSync } from './stateSync';
import { AssetCategory } from './queue';

export interface MultiUserTradingProfile {
  userId: string;
  isActive: boolean;
  exchange: 'BINANCE' | 'BITGET';
  accountType: 'REAL' | 'DEMO';
  selectedCategory: AssetCategory;
  encryptedApiKey: string;
  encryptedSecretKey: string;
  encryptedPassphrase?: string;
  marginUsdt: number;
  leverage: number;
  marginMode: 'ISOLATED' | 'CROSS';
  maxConcurrentCoins: number;
  updatedAt: number;
}

export interface DecryptedUserCredentials {
  apiKey: string;
  secretKey: string;
  passphrase?: string;
  exchange: 'BINANCE' | 'BITGET';
  accountType: 'REAL' | 'DEMO';
}

interface MultiUserDb {
  users: MultiUserTradingProfile[];
}

function getMultiUserDbPath(): string {
  return path.join(getDataDir(), 'multi_user_profiles.json');
}

export async function readMultiUserProfiles(): Promise<MultiUserTradingProfile[]> {
  const data = await readDataFileAsync<MultiUserDb>(getMultiUserDbPath(), { users: [] });
  return Array.isArray(data?.users) ? data.users : [];
}

export async function saveMultiUserProfiles(users: MultiUserTradingProfile[]): Promise<void> {
  await writeDataFileAsync(getMultiUserDbPath(), { users });
}

export async function upsertMultiUserProfile(params: {
  userId: string;
  isActive: boolean;
  exchange: 'BINANCE' | 'BITGET';
  accountType: 'REAL' | 'DEMO';
  selectedCategory: AssetCategory;
  apiKey: string;
  secretKey: string;
  passphrase?: string;
  marginUsdt?: number;
  leverage?: number;
  marginMode?: 'ISOLATED' | 'CROSS';
  maxConcurrentCoins?: number;
}): Promise<MultiUserTradingProfile> {
  const users = await readMultiUserProfiles();
  const encryptedApiKey = await encryptCredential(params.apiKey);
  const encryptedSecretKey = await encryptCredential(params.secretKey);
  const encryptedPassphrase = params.passphrase
    ? await encryptCredential(params.passphrase)
    : undefined;

  const profile: MultiUserTradingProfile = {
    userId: params.userId,
    isActive: params.isActive,
    exchange: params.exchange,
    accountType: params.accountType,
    selectedCategory: params.selectedCategory,
    encryptedApiKey,
    encryptedSecretKey,
    encryptedPassphrase,
    marginUsdt: params.marginUsdt && params.marginUsdt > 0 ? params.marginUsdt : 25,
    leverage: params.leverage && params.leverage > 0 ? params.leverage : 10,
    marginMode: params.marginMode || 'ISOLATED',
    maxConcurrentCoins: Math.max(1, Math.min(5, params.maxConcurrentCoins || 5)),
    updatedAt: Date.now(),
  };

  const idx = users.findIndex((u) => u.userId === params.userId);
  if (idx >= 0) {
    users[idx] = profile;
  } else {
    users.push(profile);
  }

  await saveMultiUserProfiles(users);
  return profile;
}

/**
 * Returns active multi-user trading profiles.
 * Falls back to the default single-user server crypto vault + stateSync if no multi-user
 * profiles have been registered yet.
 */
export async function getActiveMultiUsers(): Promise<MultiUserTradingProfile[]> {
  const profiles = await readMultiUserProfiles();
  const active = profiles.filter((u) => u.isActive && u.encryptedApiKey && u.encryptedSecretKey);
  if (active.length > 0) {
    return active;
  }

  // Fallback to existing server crypto vault + stateSync
  const state = await stateSync.getRuntimeState();
  const vault = await loadServerCryptoVault();
  if (!vault || !isCryptoVaultConfigured(vault)) {
    return [];
  }

  const exchange = vault.activeCryptoExchange || 'BINANCE';
  const creds = exchange === 'BITGET' ? vault.bitget : vault.binance;
  if (!creds?.apiKey || !creds?.secretKey) {
    return [];
  }

  return [
    {
      userId: 'default-admin',
      isActive: Boolean(state.cryptoIsAutoTrading),
      exchange,
      accountType: creds.accountType || 'DEMO',
      selectedCategory: 'ALL',
      encryptedApiKey: await encryptCredential(creds.apiKey),
      encryptedSecretKey: await encryptCredential(creds.secretKey),
      encryptedPassphrase: creds.passphrase
        ? await encryptCredential(creds.passphrase)
        : undefined,
      marginUsdt: state.cryptoMarginUsdt || 25,
      leverage: state.cryptoLeverage || 10,
      marginMode: state.cryptoMarginMode || 'ISOLATED',
      maxConcurrentCoins: Math.max(1, Math.min(5, state.cryptoMaxConcurrentCoins || 5)),
      updatedAt: Date.now(),
    },
  ].filter((u) => u.isActive);
}

/**
 * Loads and decrypts a user's exchange API Key & Secret (plus passphrase for Bitget).
 */
export async function getDecryptedUserCredentials(
  userId: string
): Promise<DecryptedUserCredentials | null> {
  const profiles = await readMultiUserProfiles();
  const profile = profiles.find((u) => u.userId === userId);

  if (profile) {
    const apiKey = await decryptCredential(profile.encryptedApiKey);
    const secretKey = await decryptCredential(profile.encryptedSecretKey);
    const passphrase = profile.encryptedPassphrase
      ? await decryptCredential(profile.encryptedPassphrase)
      : undefined;
    if (!apiKey || !secretKey) return null;

    return {
      apiKey,
      secretKey,
      passphrase,
      exchange: profile.exchange,
      accountType: profile.accountType,
    };
  }

  // Fallback for default-admin from server crypto vault
  if (userId === 'default-admin') {
    const vault = await loadServerCryptoVault();
    if (!vault) return null;
    const exchange = vault.activeCryptoExchange || 'BINANCE';
    const creds = exchange === 'BITGET' ? vault.bitget : vault.binance;
    if (!creds?.apiKey || !creds?.secretKey) return null;
    return {
      apiKey: creds.apiKey,
      secretKey: creds.secretKey,
      passphrase: creds.passphrase,
      exchange,
      accountType: creds.accountType || 'DEMO',
    };
  }

  return null;
}
