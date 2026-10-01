import { createContext, useContext, useEffect, useState, type PropsWithChildren } from 'react';

import { getAuthBackend, type Account } from '../lib/auth';

export interface AccountState {
  /** True until the stored session has been read; render nothing route-wise before then. */
  loading: boolean;
  account: Account | null;
}

const AccountContext = createContext<AccountState>({ loading: true, account: null });

/**
 * Single subscriber to auth state for the whole app. The root layout guards
 * routes on it, so a sign-out unmounts every data screen and a different user
 * signing in gets fresh fetches, never the previous user's rows.
 */
export function AccountProvider({ children }: PropsWithChildren) {
  const [state, setState] = useState<AccountState>({ loading: true, account: null });

  useEffect(() => {
    const backend = getAuthBackend();
    const unsubscribe = backend.onChange((account) => setState({ loading: false, account }));
    backend
      .getAccount()
      .then((account) => setState({ loading: false, account }))
      .catch(() => setState({ loading: false, account: null }));
    return unsubscribe;
  }, []);

  return <AccountContext.Provider value={state}>{children}</AccountContext.Provider>;
}

export function useAccount(): AccountState {
  return useContext(AccountContext);
}
