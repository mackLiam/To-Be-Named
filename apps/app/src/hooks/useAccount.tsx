import { createContext, useContext, useEffect, useState, type PropsWithChildren } from 'react';

import { becameMember, getAuthBackend, type Account } from '../lib/auth';

export interface AccountState {
  /** True until the stored session has been read; render nothing route-wise before then. */
  loading: boolean;
  account: Account | null;
  /** This guest just became a member (upgrade or merge), for the Profile
   * confirmation. Held here because a merge changes the user id, which
   * remounts every screen (app/_layout.tsx). */
  justSaved: boolean;
}

const INITIAL: AccountState = { loading: true, account: null, justSaved: false };

const AccountContext = createContext<AccountState>(INITIAL);

/**
 * Single subscriber to auth state for the whole app. The root layout guards
 * routes on it, so a sign-out unmounts every data screen and a different user
 * signing in gets fresh fetches, never the previous user's rows.
 */
export function AccountProvider({ children }: PropsWithChildren) {
  const [state, setState] = useState<AccountState>(INITIAL);

  useEffect(() => {
    const backend = getAuthBackend();
    const update = (account: Account | null) =>
      setState((prev) => ({
        loading: false,
        account,
        justSaved:
          becameMember(prev.account, account) ||
          (prev.justSaved && account?.userId === prev.account?.userId),
      }));
    const unsubscribe = backend.onChange(update);
    backend
      .getAccount()
      .then(update)
      .catch(() => update(null));
    return unsubscribe;
  }, []);

  return <AccountContext.Provider value={state}>{children}</AccountContext.Provider>;
}

export function useAccount(): AccountState {
  return useContext(AccountContext);
}
