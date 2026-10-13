/*
 * Shared wallet, contract and UI helpers (the same file is used by all five projects).
 * Load order in index.html: vendor/ethers.umd.min.js, contract-config.js, common.js, app.js
 *
 * Chain.read()        -> read-only contract (public RPC, no wallet needed)
 * Chain.send(label,f) -> asks the wallet to sign f(contract), waits for the block, shows toasts
 * Chain.account       -> connected wallet address or null
 * Chain.onChange(fn)  -> called when the account, wallet network or selected deployment changes
 */
(function () {
  "use strict";

  const config = window.CONTRACT_CONFIG || { abi: [], deployments: {} };
  const storageKey = `network:${config.contractName}`;
  const DEMO_STORAGE_KEY = `demo:expenses:${config.contractName || "ExpenseTracker"}`;
  const DEMO_MODE_KEY = `demo:active:${config.contractName || "ExpenseTracker"}`;
  const DEMO_ACCOUNT = "0x71C84920272B2eef57E0E199277dDb2bE8fB8888";

  const listeners = [];
  const state = { networkKey: null, account: null, walletChainId: null, isDemo: false };
  let readCache = null;

  function storageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage can be blocked; the choice just isn't remembered */
    }
  }

  function getDemoExpenses() {
    const raw = storageGet(DEMO_STORAGE_KEY);
    if (!raw) {
      const initial = [
        {
          id: 1,
          description: "Welcome lunch with team",
          category: "Food",
          amount: "35000",
          date: Math.floor(Date.now() / 1000) - 86400 * 2,
          recordedAt: Math.floor(Date.now() / 1000) - 86400 * 2,
        },
        {
          id: 2,
          description: "Metro card recharge",
          category: "Travel",
          amount: "50000",
          date: Math.floor(Date.now() / 1000) - 86400,
          recordedAt: Math.floor(Date.now() / 1000) - 86400,
        },
      ];
      storageSet(DEMO_STORAGE_KEY, JSON.stringify(initial));
      return initial;
    }
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  function saveDemoExpenses(list) {
    storageSet(DEMO_STORAGE_KEY, JSON.stringify(list));
  }

  function pickNetwork() {
    const keys = Object.keys(config.deployments || {});
    const saved = storageGet(storageKey);
    if (saved && keys.includes(saved)) return saved;
    if (keys.includes("monadTestnet")) return "monadTestnet";
    return keys[0] || null;
  }

  function emit() {
    renderHeader();
    for (const fn of listeners) {
      try {
        fn();
      } catch (err) {
        console.error(err);
      }
    }
  }

  function requireDeployment() {
    const dep = Chain.deployment;
    if (!dep) throw new Error("The contract is not deployed yet. Run the deploy command first (see README).");
    return dep;
  }

  function setAccount(address) {
    state.account = address ? ethers.getAddress(address) : null;
  }

  async function ensureChain(dep) {
    const current = parseInt(await window.ethereum.request({ method: "eth_chainId" }), 16);
    state.walletChainId = current;
    if (current === dep.chainId) return;

    const chainId = "0x" + dep.chainId.toString(16);
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
    } catch (err) {
      const code = err && (err.code ?? (err.data && err.data.originalError && err.data.originalError.code));
      if (code !== 4902) throw err;
      // The wallet does not know this network yet, so add it.
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId,
            chainName: dep.label,
            nativeCurrency: { name: dep.currency, symbol: dep.currency, decimals: 18 },
            rpcUrls: [dep.rpcUrl],
            ...(dep.explorer ? { blockExplorerUrls: [dep.explorer] } : {}),
          },
        ],
      });
    }
    state.walletChainId = parseInt(await window.ethereum.request({ method: "eth_chainId" }), 16);
    if (state.walletChainId !== dep.chainId) {
      throw new Error(`Please switch your wallet to ${dep.label}.`);
    }
  }

  const Chain = {
    config,

    get deployment() {
      if (state.isDemo) {
        return {
          label: "Demo Mode (Local Ledger)",
          chainId: 10143,
          currency: "MON",
          address: "0xDemoExpenseTrackerLedger",
        };
      }
      return state.networkKey ? config.deployments[state.networkKey] : null;
    },
    get account() {
      return state.account;
    },
    get isDemo() {
      return state.isDemo;
    },

    enableDemo() {
      state.isDemo = true;
      state.account = DEMO_ACCOUNT;
      state.walletChainId = 10143;
      storageSet(DEMO_MODE_KEY, "true");
      emit();
    },

    disableDemo() {
      state.isDemo = false;
      state.account = null;
      storageSet(DEMO_MODE_KEY, "false");
      emit();
    },

    resetDemoData() {
      localStorage.removeItem(DEMO_STORAGE_KEY);
      emit();
    },

    async updateExpense(id, description, category, amount, date) {
      if (state.isDemo) {
        await new Promise((r) => setTimeout(r, 150));
        const list = getDemoExpenses();
        const index = list.findIndex((e) => Number(e.id) === Number(id));
        if (index === -1) throw new Error("Expense not found");
        const spentAt = date === 0 ? Math.floor(Date.now() / 1000) : Number(date);
        list[index].description = description;
        list[index].category = category;
        list[index].amount = amount.toString();
        list[index].date = spentAt;
        saveDemoExpenses(list);
        return true;
      }
      throw new Error("Blockchain ledger records are immutable once confirmed.");
    },

    async deleteExpense(id) {
      if (state.isDemo) {
        await new Promise((r) => setTimeout(r, 150));
        const list = getDemoExpenses();
        const next = list.filter((e) => Number(e.id) !== Number(id));
        saveDemoExpenses(next);
        return true;
      }
      throw new Error("Blockchain ledger records are immutable once confirmed.");
    },

    onChange(fn) {
      listeners.push(fn);
    },

    read() {
      if (state.isDemo) {
        return {
          async getExpenses() {
            const list = getDemoExpenses();
            return list.map((e) => ({
              id: BigInt(e.id),
              description: e.description,
              category: e.category,
              amount: BigInt(e.amount),
              date: BigInt(e.date),
              recordedAt: BigInt(e.recordedAt),
            }));
          },
          async getTotal() {
            const list = getDemoExpenses();
            return list.reduce((sum, e) => sum + BigInt(e.amount), 0n);
          },
          async getExpenseCount() {
            return BigInt(getDemoExpenses().length);
          },
          async getTotalByCategory(category) {
            return getDemoExpenses()
              .filter((e) => e.category === category)
              .reduce((sum, e) => sum + BigInt(e.amount), 0n);
          },
        };
      }
      const dep = requireDeployment();
      if (!readCache || readCache.key !== state.networkKey) {
        const provider = new ethers.JsonRpcProvider(dep.rpcUrl, dep.chainId, {
          staticNetwork: true,
          batchMaxCount: 1,
        });
        readCache = { key: state.networkKey, contract: new ethers.Contract(dep.address, config.abi, provider) };
      }
      return readCache.contract;
    },

    async connect() {
      if (!window.ethereum) {
        Chain.enableDemo();
        UI.toast("No MetaMask detected. Demo Mode enabled — you can now add and track expenses!", "info").closeAfter(6000);
        return state.account;
      }
      state.isDemo = false;
      storageSet(DEMO_MODE_KEY, "false");
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      setAccount(accounts[0]);
      if (Chain.deployment) await ensureChain(Chain.deployment);
      emit();
      return state.account;
    },

    /** A contract instance that signs with the connected wallet on the right network. */
    async write() {
      if (state.isDemo) {
        return {
          async addExpense(description, category, amount, date) {
            await new Promise((r) => setTimeout(r, 350));
            const now = Math.floor(Date.now() / 1000);
            const spentAt = date === 0 ? now : Number(date);
            const list = getDemoExpenses();
            const newId = list.length + 1;
            list.push({
              id: newId,
              description,
              category,
              amount: amount.toString(),
              date: spentAt,
              recordedAt: now,
            });
            saveDemoExpenses(list);
            const txHash = "0x" + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
            return {
              hash: txHash,
              async wait() {
                return {
                  status: 1,
                  logs: [],
                  transactionHash: txHash,
                };
              },
            };
          },
        };
      }
      const dep = requireDeployment();
      if (!state.account) await Chain.connect();
      await ensureChain(dep);
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner(state.account);
      return new ethers.Contract(dep.address, config.abi, signer);
    },

    /**
     * Send a transaction with progress toasts. Returns the receipt, or null if it
     * failed or was rejected (the error is already shown to the user).
     */
    async send(label, buildTx) {
      const isDemo = state.isDemo;
      const toast = UI.toast(`${label}: ${isDemo ? "saving to local ledger…" : "confirm in your wallet…"}`, "pending");
      try {
        const contract = await Chain.write();
        const tx = await buildTx(contract);
        if (!isDemo) {
          toast.update(`${label}: waiting for confirmation…`, "pending", UI.txLink(tx.hash));
        }
        const receipt = await tx.wait();
        toast.update(`${label}: recorded successfully!`, "success", isDemo ? null : UI.txLink(tx.hash));
        toast.closeAfter(5000);
        return receipt;
      } catch (err) {
        console.error(err);
        toast.update(Chain.errorMessage(err), "error");
        toast.closeAfter(9000);
        return null;
      }
    },

    /** Find a named event emitted by this contract in a transaction receipt. */
    findEvent(receipt, name) {
      const iface = new ethers.Interface(config.abi);
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog(log);
          if (parsed && parsed.name === name) return parsed;
        } catch {
          /* log from another contract */
        }
      }
      return null;
    },

    errorMessage(err) {
      if (!err) return "Something went wrong.";
      const nestedCode = err.info && err.info.error && err.info.error.code;
      if (err.code === "ACTION_REJECTED" || err.code === 4001 || nestedCode === 4001) {
        return "You rejected the request in your wallet.";
      }
      if (err.reason) return err.reason;
      if (err.revert && err.revert.args && err.revert.args.length) return String(err.revert.args[0]);
      const nested = (err.info && err.info.error && err.info.error.message) || (err.error && err.error.message);
      const message = String(err.shortMessage || nested || err.message || err);
      if (/insufficient funds/i.test(message)) {
        const dep = Chain.deployment;
        const faucet = dep && dep.faucet ? ` Get free testnet ${dep.currency} at ${dep.faucet}` : "";
        return `Not enough ${dep ? dep.currency : "funds"} to pay for gas.${faucet}`;
      }
      return message.replace(/^execution reverted:?\s*/i, "");
    },
  };

  // ------------------------------------------------------------------ UI helpers

  const UI = {
    $(selector, root) {
      return (root || document).querySelector(selector);
    },

    escape(value) {
      return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
    },

    shortAddress(address) {
      return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "";
    },

    sameAddress(a, b) {
      return !!a && !!b && a.toLowerCase() === b.toLowerCase();
    },

    /** Unix seconds (number or bigint) -> readable local date and time. */
    dateTime(seconds) {
      const ms = Number(seconds) * 1000;
      if (!ms) return "—";
      return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    },

    date(seconds, options) {
      const ms = Number(seconds) * 1000;
      if (!ms) return "—";
      return new Date(ms).toLocaleDateString(undefined, { dateStyle: "medium", ...(options || {}) });
    },

    explorerUrl(kind, value) {
      const dep = Chain.deployment;
      return dep && dep.explorer ? `${dep.explorer}/${kind}/${value}` : null;
    },

    txLink(hash) {
      return UI.explorerUrl("tx", hash);
    },

    /** Short address, linked to the explorer when there is one. */
    addressHtml(address) {
      const url = UI.explorerUrl("address", address);
      const text = `<code class="addr" title="${UI.escape(address)}">${UI.escape(UI.shortAddress(address))}</code>`;
      return url ? `<a href="${url}" target="_blank" rel="noopener">${text}</a>` : text;
    },

    /** Contracts limit text by UTF-8 bytes, which is more than the character count for non-English text. */
    byteLength(text) {
      return new TextEncoder().encode(text).length;
    },

    /** Live "used / max" counter under a text field; the element #<fieldId>Counter shows it. */
    bindCounter(field, maxBytes) {
      const counter = document.getElementById(`${field.id}Counter`);
      const update = () => {
        const used = UI.byteLength(field.value.trim());
        field.setCustomValidity(used > maxBytes ? `Too long: ${used} of ${maxBytes} bytes` : "");
        if (counter) {
          counter.textContent = `${used} / ${maxBytes}`;
          counter.classList.toggle("over", used > maxBytes);
        }
      };
      field.addEventListener("input", update);
      field.form && field.form.addEventListener("reset", () => setTimeout(update));
      update();
      return update;
    },

    setBusy(button, busy, busyLabel) {
      if (!button) return;
      if (busy) {
        button.dataset.label = button.textContent;
        button.textContent = busyLabel || "Working…";
        button.disabled = true;
      } else {
        button.textContent = button.dataset.label || button.textContent;
        button.disabled = false;
      }
    },

    toast(message, type) {
      let box = document.getElementById("toasts");
      if (!box) {
        box = document.createElement("div");
        box.id = "toasts";
        box.setAttribute("aria-live", "polite");
        document.body.appendChild(box);
      }
      const el = document.createElement("div");
      box.appendChild(el);
      let timer = null;
      const handle = {
        update(text, kind, link) {
          el.className = `toast toast-${kind || "info"}`;
          el.innerHTML =
            `<span>${UI.escape(text)}</span>` +
            (link ? ` <a href="${link}" target="_blank" rel="noopener">View transaction</a>` : "") +
            `<button class="toast-close" aria-label="Dismiss">×</button>`;
          el.querySelector(".toast-close").onclick = handle.close;
        },
        closeAfter(ms) {
          clearTimeout(timer);
          timer = setTimeout(handle.close, ms);
        },
        close() {
          clearTimeout(timer);
          el.remove();
        },
      };
      handle.update(message, type);
      if (type === "success" || type === "info") handle.closeAfter(5000);
      return handle;
    },

    copy(text) {
      navigator.clipboard.writeText(text).then(
        () => UI.toast("Copied", "info"),
        () => UI.toast("Could not copy - select the text and copy it manually", "error")
      );
    },
  };

  // ------------------------------------------------------------------ header

  function renderHeader() {
    const dep = Chain.deployment;
    const btn = UI.$("#connectBtn");
    const demoBtn = UI.$("#demoBtn");
    const demoBanner = UI.$("#demoBanner");
    const badge = UI.$("#networkBadge");
    const select = UI.$("#networkSelect");
    const banner = UI.$("#notDeployed");
    const info = UI.$("#contractInfo");

    if (banner) banner.hidden = !!dep;
    if (demoBanner) demoBanner.hidden = !state.isDemo;

    if (select) {
      const keys = Object.keys(config.deployments || {});
      select.hidden = keys.length < 2 || state.isDemo;
      select.innerHTML = keys
        .map((k) => `<option value="${k}" ${k === state.networkKey ? "selected" : ""}>${UI.escape(config.deployments[k].label)}</option>`)
        .join("");
    }

    if (demoBtn) {
      if (state.isDemo) {
        demoBtn.textContent = "Reset Demo Data";
        demoBtn.className = "btn btn-secondary";
        demoBtn.title = "Clear saved demo expenses and reset";
      } else {
        demoBtn.textContent = "⚡ Demo Mode";
        demoBtn.className = "btn btn-secondary";
        demoBtn.title = "Test without MetaMask extension";
      }
    }

    if (badge) {
      if (state.isDemo) {
        badge.textContent = "⚡ Demo Mode";
        badge.title = "Expenses stored in browser ledger (no MetaMask needed)";
        badge.className = "chip chip-ok";
      } else if (!dep) {
        badge.textContent = "Not deployed";
        badge.className = "chip chip-muted";
      } else if (state.account && state.walletChainId !== null && state.walletChainId !== dep.chainId) {
        badge.textContent = `Wrong network`;
        badge.title = `Your wallet is on chain ${state.walletChainId}. This app uses ${dep.label}.`;
        badge.className = "chip chip-warning";
      } else {
        badge.textContent = dep.label;
        badge.title = `Chain ID ${dep.chainId}`;
        badge.className = "chip chip-ok";
      }
    }

    if (btn) {
      if (state.isDemo) {
        btn.textContent = "Connect MetaMask";
        btn.title = "Connect real MetaMask wallet";
        btn.classList.remove("btn-connected");
      } else {
        btn.textContent = state.account ? UI.shortAddress(state.account) : "Connect wallet";
        btn.title = state.account || "Connect MetaMask";
        btn.classList.toggle("btn-connected", !!state.account);
      }
    }

    if (info) {
      if (state.isDemo) {
        info.innerHTML = `⚡ <strong>Demo Mode:</strong> Running with a local persistent ledger (no gas or wallet extension required).`;
      } else if (dep) {
        const url = UI.explorerUrl("address", dep.address);
        const addr = `<code>${UI.escape(dep.address)}</code>`;
        info.innerHTML = `Contract on ${UI.escape(dep.label)}: ${url ? `<a href="${url}" target="_blank" rel="noopener">${addr}</a>` : addr}`;
      } else {
        info.textContent = "";
      }
    }
  }

  async function init() {
    state.networkKey = pickNetwork();

    // If MetaMask is not installed or user previously opted for demo mode, auto-enable demo mode
    const savedDemo = storageGet(DEMO_MODE_KEY);
    if (savedDemo === "true" || (!window.ethereum && savedDemo !== "false")) {
      state.isDemo = true;
      state.account = DEMO_ACCOUNT;
      state.walletChainId = 10143;
    }

    const demoBtn = UI.$("#demoBtn");
    if (demoBtn) {
      demoBtn.addEventListener("click", () => {
        if (state.isDemo) {
          if (confirm("Reset demo expenses to initial state?")) {
            Chain.resetDemoData();
            UI.toast("Demo expenses reset", "info");
          }
        } else {
          Chain.enableDemo();
          UI.toast("Demo Mode enabled! You can now add and track expenses.", "success");
        }
      });
    }

    const btn = UI.$("#connectBtn");
    if (btn) {
      btn.addEventListener("click", async () => {
        try {
          await Chain.connect();
        } catch (err) {
          UI.toast(Chain.errorMessage(err), "error").closeAfter(8000);
        }
      });
    }

    const select = UI.$("#networkSelect");
    if (select) {
      select.addEventListener("change", () => {
        state.networkKey = select.value;
        storageSet(storageKey, select.value);
        emit();
      });
    }

    if (window.ethereum) {
      if (window.ethereum.on) {
        window.ethereum.on("accountsChanged", (accounts) => {
          if (accounts && accounts.length) {
            state.isDemo = false;
            storageSet(DEMO_MODE_KEY, "false");
            setAccount(accounts[0]);
          } else {
            setAccount(null);
          }
          emit();
        });
        window.ethereum.on("chainChanged", (chainId) => {
          state.walletChainId = parseInt(chainId, 16);
          emit();
        });
      }
      // Silently restore a connection the user already approved earlier (if not in demo mode).
      if (!state.isDemo) {
        try {
          const accounts = await window.ethereum.request({ method: "eth_accounts" });
          if (accounts && accounts[0]) {
            setAccount(accounts[0]);
            state.walletChainId = parseInt(await window.ethereum.request({ method: "eth_chainId" }), 16);
          }
        } catch {
          /* wallet locked or unavailable */
        }
      }
    }
    emit();
  }

  window.Chain = Chain;
  window.UI = UI;
  document.addEventListener("DOMContentLoaded", init);
})();
