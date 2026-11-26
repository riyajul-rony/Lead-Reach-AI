import { localDevStore, ensureDevAdminUser } from "./local-store";

// In-memory demo store for when PostgreSQL is not running locally
class LocalDevMockDb {
  workspaces = {
    findMany: async ({ where, take, skip, orderBy }: any = {}) => {
      let items = localDevStore.getWorkspaces((w) => {
        if (where?.id && w.id !== where.id) return false;
        if (where?.user_id && w.user_id !== where.user_id) return false;
        if (where?.is_default !== undefined && w.is_default !== where.is_default) return false;
        if (where?.sending_status && w.sending_status !== where.sending_status) return false;
        return true;
      });
      if (orderBy) {
        const orderKey = Object.keys(orderBy)[0];
        const dir = orderBy[orderKey] === "asc" ? 1 : -1;
        items = [...items].sort((a, b) => {
          const valA = a[orderKey] ?? "";
          const valB = b[orderKey] ?? "";
          if (valA < valB) return -1 * dir;
          if (valA > valB) return 1 * dir;
          return 0;
        });
      }
      if (skip && typeof skip === "number") items = items.slice(skip);
      if (take && typeof take === "number") items = items.slice(0, take);
      return items;
    },
    findUnique: async ({ where }: any = {}) =>
      localDevStore.findWorkspace((w) => !where?.id || w.id === where.id),
    findFirst: async ({ where }: any = {}) =>
      localDevStore.findWorkspace((w) => {
        if (where?.id && w.id !== where.id) return false;
        if (where?.user_id && w.user_id !== where.user_id) return false;
        if (where?.is_default !== undefined && w.is_default !== where.is_default) return false;
        return true;
      }),
    create: async ({ data }: any) => localDevStore.saveWorkspace(data),
    update: async ({ where, data }: any) => localDevStore.updateWorkspace(where?.id, data),
    updateMany: async ({ where, data }: any = {}) => {
      const items = localDevStore.getWorkspaces((w) => {
        if (where?.id && w.id !== where.id) return false;
        if (where?.user_id && w.user_id !== where.user_id) return false;
        return true;
      });
      let count = 0;
      for (const item of items) {
        localDevStore.updateWorkspace(item.id, data);
        count++;
      }
      return { count };
    },
    delete: async ({ where }: any) => localDevStore.deleteWhere("workspaces", (w) => w.id === where?.id),
    deleteMany: async ({ where }: any = {}) =>
      localDevStore.deleteWhere("workspaces", (w) => {
        if (where?.id && w.id !== where.id) return false;
        if (where?.user_id && w.user_id !== where.user_id) return false;
        return true;
      }),
    count: async ({ where }: any = {}) =>
      localDevStore.getWorkspaces((w) => {
        if (where?.user_id && w.user_id !== where.user_id) return false;
        if (where?.sending_status && w.sending_status !== where.sending_status) return false;
        return true;
      }).length,
  };

  users = {
    findMany: async ({ where, take, skip, orderBy }: any = {}) => {
      await ensureDevAdminUser();
      let items = localDevStore.getUsers((u) => {
        if (where?.role) {
          if (where.role.in && Array.isArray(where.role.in)) {
            if (!where.role.in.includes(u.role)) return false;
          } else if (u.role !== where.role) {
            return false;
          }
        }
        if (where?.status && u.status !== where.status) return false;
        if (where?.plan && u.plan !== where.plan) return false;
        if (where?.email && u.email?.toLowerCase() !== where.email?.toLowerCase()) return false;
        if (where?.OR && Array.isArray(where.OR)) {
          const matched = where.OR.some((cond: any) => {
            if (cond.name?.contains && cond.name.mode === "insensitive") {
              return u.name?.toLowerCase().includes(cond.name.contains.toLowerCase());
            }
            if (cond.email?.contains && cond.email.mode === "insensitive") {
              return u.email?.toLowerCase().includes(cond.email.contains.toLowerCase());
            }
            return false;
          });
          if (!matched) return false;
        }
        return true;
      });

      if (orderBy) {
        const orderKey = Object.keys(orderBy)[0];
        const dir = orderBy[orderKey] === "asc" ? 1 : -1;
        items = [...items].sort((a, b) => {
          const valA = a[orderKey] ?? "";
          const valB = b[orderKey] ?? "";
          if (valA < valB) return -1 * dir;
          if (valA > valB) return 1 * dir;
          return 0;
        });
      } else {
        items = [...items].sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
      }

      if (skip && typeof skip === "number") items = items.slice(skip);
      if (take && typeof take === "number") items = items.slice(0, take);
      return items;
    },
    findUnique: async ({ where }: any = {}) => {
      await ensureDevAdminUser();
      return localDevStore.findUser((u) => (where?.id && u.id === where.id) || (where?.email && u.email?.toLowerCase() === where.email?.toLowerCase()));
    },
    findFirst: async ({ where }: any = {}) => {
      await ensureDevAdminUser();
      return localDevStore.findUser((u) => (where?.id && u.id === where.id) || (where?.email && u.email?.toLowerCase() === where.email?.toLowerCase()));
    },
    create: async ({ data }: any) => localDevStore.saveUser(data),
    update: async ({ where, data }: any) => localDevStore.updateUser(where?.id || where?.email, data),
    delete: async ({ where }: any) => localDevStore.deleteUser(where?.id || where?.email),
    deleteMany: async ({ where }: any = {}) => {
      const idOrEmail = where?.id || where?.email;
      if (idOrEmail) {
        const res = localDevStore.deleteUser(idOrEmail);
        return { count: res ? 1 : 0 };
      }
      return { count: 0 };
    },
    count: async ({ where }: any = {}) => {
      await ensureDevAdminUser();
      return localDevStore.getUsers((u) => {
        if (where?.role) {
          if (where.role.in && Array.isArray(where.role.in)) {
            if (!where.role.in.includes(u.role)) return false;
          } else if (u.role !== where.role) {
            return false;
          }
        }
        if (where?.status && u.status !== where.status) return false;
        if (where?.plan && u.plan !== where.plan) return false;
        if (where?.OR && Array.isArray(where.OR)) {
          const matched = where.OR.some((cond: any) => {
            if (cond.name?.contains && cond.name.mode === "insensitive") {
              return u.name?.toLowerCase().includes(cond.name.contains.toLowerCase());
            }
            if (cond.email?.contains && cond.email.mode === "insensitive") {
              return u.email?.toLowerCase().includes(cond.email.contains.toLowerCase());
            }
            return false;
          });
          if (!matched) return false;
        }
        return true;
      }).length;
    },
  };

  sessions = {
    findUnique: async ({ where, include, select }: any) => {
      const sess = localDevStore.findSession((s) => (where.token_hash && s.token_hash === where.token_hash) || (where.id && s.id === where.id));
      if (!sess) return null;
      if (include?.user || select?.user) {
        const user = localDevStore.findUser((u) => u.id === sess.user_id) || localDevStore.getUsers()[0];
        return { ...sess, user };
      }
      return sess;
    },
    findFirst: async ({ where, include, select }: any = {}) => {
      const sess = localDevStore.findSession((s) => (!where?.user_id || s.user_id === where.user_id) && (!where?.token_hash || s.token_hash === where.token_hash));
      if (!sess) return null;
      if (include?.user || select?.user) {
        const user = localDevStore.findUser((u) => u.id === sess.user_id) || localDevStore.getUsers()[0];
        return { ...sess, user };
      }
      return sess;
    },
    create: async ({ data }: any) => {
      const sess = {
        id: data.id || `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        created_at: new Date(),
        ...data,
      };
      return localDevStore.saveSession(sess);
    },
    update: async ({ where, data }: any) => {
      return localDevStore.updateSession(where.id, data) || { ...data };
    },
    deleteMany: async ({ where }: any = {}) => {
      localDevStore.deleteSessions((s) => (!where?.token_hash || s.token_hash === where.token_hash) && (!where?.user_id || s.user_id === where.user_id));
      return { count: 1 };
    },
  };

  verification_tokens = {
    findUnique: async ({ where }: any = {}) => {
      return localDevStore.findVerificationToken(
        (t) =>
          (where?.token_hash && t.token_hash === where.token_hash) ||
          (where?.id && t.id === where.id)
      );
    },
    findFirst: async ({ where }: any = {}) => {
      return localDevStore.findVerificationToken(
        (t) =>
          (!where?.token_hash || t.token_hash === where.token_hash) &&
          (!where?.purpose || t.purpose === where.purpose) &&
          (!where?.identifier || t.identifier === where.identifier)
      );
    },
    create: async ({ data }: any) => localDevStore.saveVerificationToken(data),
    update: async ({ where, data }: any) => {
      const id = where?.id || where?.token_hash;
      return localDevStore.updateVerificationToken(id, data);
    },
    updateMany: async ({ where, data }: any) => {
      const count = localDevStore.updateManyVerificationTokens((t) => {
        if (where?.id && t.id !== where.id) return false;
        if (where?.token_hash && t.token_hash !== where.token_hash) return false;
        if (where?.used_at === null && (t.used_at !== null && t.used_at !== undefined)) return false;
        return true;
      }, data);
      return { count };
    },
    deleteMany: async ({ where }: any = {}) => {
      const count = localDevStore.deleteManyVerificationTokens((t) => {
        if (where?.identifier && t.identifier?.toLowerCase() !== where.identifier?.toLowerCase()) return false;
        if (where?.token_hash && t.token_hash !== where.token_hash) return false;
        return true;
      });
      return { count };
    },
  };

  system_settings = {
    findUnique: async ({ where }: any) => {
      return localDevStore.findSystemSetting((s) => s.key === where.key);
    },
    findMany: async ({ where }: any = {}) => {
      return localDevStore.getSystemSettings((s) => {
        if (where?.key?.in && Array.isArray(where.key.in)) {
          return where.key.in.includes(s.key);
        }
        return true;
      });
    },
    upsert: async ({ where, create, update }: any) => {
      const data = update || create;
      return localDevStore.upsertSystemSetting(where.key, data);
    },
    deleteMany: async ({ where }: any = {}) => {
      return localDevStore.deleteSystemSettings(where?.key ? (s: any) => s.key === where.key : undefined);
    },
    delete: async ({ where }: any) => {
      localDevStore.deleteSystemSettings((s: any) => s.key === where.key);
      return { key: where.key };
    },
  };

  api_keys = {
    findMany: async ({ where }: any = {}) => {
      return localDevStore.getApiKeys(
        (k) =>
          (!where?.user_id || k.user_id === where.user_id) &&
          (!where?.provider || k.provider === where.provider) &&
          (!where?.status || k.status === where.status)
      );
    },
    findFirst: async ({ where }: any = {}) => {
      return localDevStore.findApiKey(
        (k) =>
          (!where?.user_id || k.user_id === where.user_id) &&
          (!where?.id || k.id === where.id) &&
          (!where?.provider || k.provider === where.provider) &&
          (!where?.status || k.status === where.status)
      );
    },
    findUnique: async ({ where }: any = {}) => {
      return localDevStore.findApiKey((k) => k.id === where.id);
    },
    create: async ({ data }: any) => {
      return localDevStore.saveApiKey(data);
    },
    delete: async ({ where }: any) => {
      localDevStore.deleteApiKey(where.id);
      return { id: where.id };
    },
    deleteMany: async ({ where }: any = {}) => {
      return localDevStore.deleteWhere("api_keys", (k) => !where?.user_id || k.user_id === where.user_id);
    },
    count: async ({ where }: any = {}) => {
      return localDevStore.getApiKeys(
        (k) =>
          (!where?.user_id || k.user_id === where.user_id) &&
          (!where?.provider || k.provider === where.provider) &&
          (!where?.status || k.status === where.status)
      ).length;
    },
  };

  social_accounts = {
    findMany: async ({ where }: any = {}) => {
      return localDevStore.getSocialAccounts(
        (a) => (!where?.user_id || a.user_id === where.user_id) && (!where?.provider || a.provider === where.provider)
      );
    },
    findFirst: async ({ where }: any = {}) => {
      return localDevStore.findSocialAccount(
        (a) =>
          (!where?.user_id || a.user_id === where.user_id) &&
          (!where?.provider || a.provider === where.provider) &&
          (!where?.id || a.id === where.id) &&
          (!where?.external_id || a.external_id === where.external_id)
      );
    },
    findUnique: async ({ where }: any = {}) => {
      return localDevStore.findSocialAccount((a) => a.id === where.id);
    },
    create: async ({ data }: any) => {
      return localDevStore.saveSocialAccount(data);
    },
    update: async ({ where, data }: any) => {
      return localDevStore.saveSocialAccount({ ...where, ...data });
    },
    upsert: async ({ where, create, update }: any) => {
      const existing = localDevStore.findSocialAccount(
        (a) =>
          (where?.user_id_provider_external_id &&
            a.user_id === where.user_id_provider_external_id.user_id &&
            a.provider === where.user_id_provider_external_id.provider &&
            a.external_id === where.user_id_provider_external_id.external_id) ||
          (where?.id && a.id === where.id)
      );
      if (existing) {
        return localDevStore.saveSocialAccount({ ...existing, ...update });
      }
      return localDevStore.saveSocialAccount(create);
    },
    delete: async ({ where }: any) => {
      localDevStore.deleteSocialAccount(where.id, where.user_id);
      return { id: where.id };
    },
    count: async ({ where }: any = {}) => {
      return localDevStore.getSocialAccounts(where?.user_id ? (a) => a.user_id === where.user_id : undefined).length;
    },
  };

  email_accounts = {
    findMany: async ({ where }: any = {}) => {
      return localDevStore.getEmailAccounts((a) => {
        if (where?.user_id && a.user_id !== where.user_id) return false;
        if (where?.status && a.status !== where.status) return false;
        if (where?.id?.in && Array.isArray(where.id.in) && !where.id.in.includes(a.id)) return false;
        if (where?.OR && Array.isArray(where.OR)) {
          const orMatch = where.OR.some((cond: any) => {
            if (cond.reply_inbox_account_id && a.reply_inbox_account_id === cond.reply_inbox_account_id) return true;
            if (cond.reply_to && a.reply_to?.toLowerCase() === cond.reply_to?.toLowerCase()) return true;
            return false;
          });
          if (!orMatch) return false;
        }
        return true;
      });
    },
    findFirst: async ({ where }: any = {}) => {
      return localDevStore.findEmailAccount(
        (a) => (!where?.user_id || a.user_id === where.user_id) && (!where?.id || a.id === where.id) && (!where?.from_email || a.from_email === where.from_email)
      );
    },
    findUnique: async ({ where }: any = {}) => {
      return localDevStore.findEmailAccount((a) => a.id === where.id);
    },
    create: async ({ data }: any) => {
      return localDevStore.saveEmailAccount(data);
    },
    update: async ({ where, data }: any) => {
      const existing = localDevStore.findEmailAccount((a) => a.id === where.id);
      return localDevStore.saveEmailAccount({ ...existing, ...data });
    },
    delete: async ({ where }: any) => {
      localDevStore.deleteEmailAccount(where.id);
      return { id: where.id };
    },
    deleteMany: async ({ where }: any = {}) => {
      return localDevStore.deleteWhere("email_accounts", (a) => !where?.user_id || a.user_id === where.user_id);
    },
    count: async ({ where }: any = {}) => {
      return localDevStore.getEmailAccounts(where?.user_id ? (a) => a.user_id === where.user_id : undefined).length;
    },
  };

  outreach_campaigns = {
    findMany: async ({ where }: any = {}) => {
      return localDevStore.getOutreachCampaigns(
        (c) => (!where?.user_id || c.user_id === where.user_id) && (!where?.status || c.status === where.status)
      );
    },
    findFirst: async ({ where }: any = {}) => {
      return localDevStore.findOutreachCampaign(
        (c) => (!where?.user_id || c.user_id === where.user_id) && (!where?.id || c.id === where.id)
      );
    },
    findUnique: async ({ where }: any = {}) => {
      return localDevStore.findOutreachCampaign((c) => c.id === where.id);
    },
    create: async ({ data }: any) => {
      return localDevStore.saveOutreachCampaign(data);
    },
    update: async ({ where, data }: any) => {
      const existing = localDevStore.findOutreachCampaign((c) => c.id === where.id);
      return localDevStore.saveOutreachCampaign({ ...existing, ...data });
    },
    delete: async ({ where }: any) => {
      localDevStore.deleteOutreachCampaign(where.id);
      return { id: where.id };
    },
    deleteMany: async ({ where }: any = {}) => {
      return localDevStore.deleteWhere("outreach_campaigns", (c) => !where?.user_id || c.user_id === where.user_id);
    },
    updateMany: async ({ where, data }: any = {}) => {
      const items = localDevStore.getOutreachCampaigns((c) => (!where?.user_id || c.user_id === where.user_id) && (!where?.status || c.status === where.status));
      for (const item of items) {
        localDevStore.saveOutreachCampaign({ ...item, ...data });
      }
      return { count: items.length };
    },
    count: async ({ where }: any = {}) => {
      return localDevStore.getOutreachCampaigns(where?.user_id ? (c) => c.user_id === where.user_id : undefined).length;
    },
  };

  campaign_recipients = {
    findMany: async ({ where, take, orderBy }: any = {}) => {
      let items = localDevStore.getRecipients(
        (r) =>
          (!where?.user_id || r.user_id === where.user_id) &&
          (!where?.campaign_id || r.campaign_id === where.campaign_id) &&
          (!where?.id || (where.id?.in ? where.id.in.includes(r.id) : r.id === where.id)) &&
          (!where?.status || (where.status?.in ? where.status.in.includes(r.status) : r.status === where.status)) &&
          (!where?.assigned_account_id || r.assigned_account_id === where.assigned_account_id) &&
          (!where?.sending_started_at?.lt || (r.sending_started_at && new Date(r.sending_started_at) < new Date(where.sending_started_at.lt)))
      );
      if (take && typeof take === "number") {
        items = items.slice(0, take);
      }
      return items;
    },
    findFirst: async ({ where }: any = {}) => {
      return localDevStore.findRecipient(
        (r) =>
          (!where?.id || r.id === where.id) &&
          (!where?.user_id || r.user_id === where.user_id) &&
          (!where?.thread_message_id || r.thread_message_id === where.thread_message_id) &&
          (!where?.unsubscribe_token || r.unsubscribe_token === where.unsubscribe_token) &&
          (!where?.email || r.email.toLowerCase() === where.email.toLowerCase()) &&
          (!where?.campaign_id || r.campaign_id === where.campaign_id) &&
          (!where?.assigned_account_id || (where.assigned_account_id?.in ? where.assigned_account_id.in.includes(r.assigned_account_id) : r.assigned_account_id === where.assigned_account_id))
      );
    },
    findUnique: async ({ where }: any = {}) => {
      return localDevStore.findRecipient((r) => (!where?.id || r.id === where.id) && (!where?.unsubscribe_token || r.unsubscribe_token === where.unsubscribe_token));
    },
    create: async ({ data }: any) => localDevStore.saveRecipient(data),
    createMany: async ({ data }: any) => {
      const list = Array.isArray(data) ? data : [data];
      for (const item of list) {
        localDevStore.saveRecipient(item);
      }
      return { count: list.length };
    },
    update: async ({ where, data }: any) => {
      const existing = localDevStore.findRecipient((r) => (!where?.id || r.id === where.id) && (!where?.unsubscribe_token || r.unsubscribe_token === where.unsubscribe_token));
      return localDevStore.saveRecipient({ ...existing, ...data });
    },
    updateMany: async ({ where, data }: any = {}) => {
      const items = localDevStore.getRecipients((r) => {
        if (where?.id) {
          if (where.id?.in && Array.isArray(where.id.in)) {
            if (!where.id.in.includes(r.id)) return false;
          } else if (r.id !== where.id) {
            return false;
          }
        }
        if (where?.campaign_id && r.campaign_id !== where.campaign_id) return false;
        if (where?.user_id && r.user_id !== where.user_id) return false;
        if (where?.status) {
          if (where.status?.in && Array.isArray(where.status.in)) {
            if (!where.status.in.includes(r.status)) return false;
          } else if (r.status !== where.status) {
            return false;
          }
        }
        if (where?.next_followup_at?.lt) {
          if (!r.next_followup_at || new Date(r.next_followup_at) >= new Date(where.next_followup_at.lt)) return false;
        }
        if (where?.created_at?.lt) {
          if (!r.created_at || new Date(r.created_at) >= new Date(where.created_at.lt)) return false;
        }
        if (where?.sending_started_at?.lt) {
          if (!r.sending_started_at || new Date(r.sending_started_at) >= new Date(where.sending_started_at.lt)) return false;
        }
        return true;
      });
      for (const item of items) {
        localDevStore.saveRecipient({ ...item, ...data });
      }
      return { count: items.length };
    },
    count: async ({ where }: any = {}) => {
      return localDevStore.getRecipients(
        (r) =>
          (!where?.user_id || r.user_id === where.user_id) &&
          (!where?.campaign_id || r.campaign_id === where.campaign_id) &&
          (!where?.status || (where.status?.in ? where.status.in.includes(r.status) : r.status === where.status))
      ).length;
    },
    deleteMany: async ({ where }: any = {}) => {
      return localDevStore.deleteWhere("campaign_recipients", (r) => !where?.user_id || r.user_id === where.user_id);
    },
  };

  outreach_campaign_accounts = {
    create: async ({ data }: any) => data,
    createMany: async ({ data }: any) => ({ count: Array.isArray(data) ? data.length : 1 }),
    findMany: async ({ where }: any = {}) => [],
    deleteMany: async () => ({ count: 1 }),
  };

  suppressions = {
    findMany: async ({ where }: any = {}) => {
      return localDevStore.getSuppressions((s) => {
        if (where?.user_id && s.user_id !== where.user_id) return false;
        if (where?.email?.in && Array.isArray(where.email.in)) {
          return where.email.in.some((e: string) => e.toLowerCase() === s.email.toLowerCase());
        }
        return true;
      });
    },
    findFirst: async ({ where }: any = {}) => {
      return localDevStore.getSuppressions((s) => (!where?.user_id || s.user_id === where.user_id) && (!where?.email || s.email.toLowerCase() === where.email.toLowerCase()))[0] || null;
    },
    findUnique: async ({ where }: any = {}) => {
      return localDevStore.getSuppressions((s) => (!where?.user_id || s.user_id === where.user_id) && (!where?.email || s.email.toLowerCase() === where.email.toLowerCase()))[0] || null;
    },
    create: async ({ data }: any) => localDevStore.saveSuppression({ ...data, email: data.email.toLowerCase() }),
    deleteMany: async ({ where }: any = {}) => {
      return localDevStore.deleteWhere("suppressions", (s) => !where?.user_id || s.user_id === where.user_id);
    },
    count: async ({ where }: any = {}) => {
      return localDevStore.getSuppressions((s) => !where?.user_id || s.user_id === where.user_id).length;
    },
  };

  email_messages = {
    findMany: async ({ where, take, skip, orderBy }: any = {}) => {
      let items = localDevStore.getEmailMessages((m) => {
        if (where?.id && m.id !== where.id) return false;
        if (where?.user_id && m.user_id !== where.user_id) return false;
        if (where?.direction && m.direction !== where.direction) return false;
        if (where?.kind && m.kind !== where.kind) return false;
        if (where?.step_no !== undefined && m.step_no !== where.step_no) return false;
        if (where?.status && m.status !== where.status) return false;
        if (where?.reply_category && m.reply_category !== where.reply_category) return false;
        if (where?.email_account_id && m.email_account_id !== where.email_account_id) return false;
        if (where?.variant_id !== undefined) {
          if (where.variant_id?.not === null && (m.variant_id === null || m.variant_id === undefined)) return false;
          else if (typeof where.variant_id === "string" && m.variant_id !== where.variant_id) return false;
        }
        if (where?.recipient_id) {
          if (where.recipient_id?.in && Array.isArray(where.recipient_id.in)) {
            if (!where.recipient_id.in.includes(m.recipient_id)) return false;
          } else if (m.recipient_id !== where.recipient_id) {
            return false;
          }
        }
        return true;
      });
      if (orderBy?.sent_at === "desc" || orderBy?.created_at === "desc") {
        items = [...items].sort((a, b) => new Date(b.sent_at || b.created_at || 0).getTime() - new Date(a.sent_at || a.created_at || 0).getTime());
      }
      if (skip && typeof skip === "number") items = items.slice(skip);
      if (take && typeof take === "number") items = items.slice(0, take);
      return items;
    },
    findFirst: async ({ where }: any = {}) => {
      return localDevStore.getEmailMessages((m) => {
        if (where?.id && m.id !== where.id) return false;
        if (where?.user_id && m.user_id !== where.user_id) return false;
        if (where?.direction && m.direction !== where.direction) return false;
        if (where?.kind && m.kind !== where.kind) return false;
        if (where?.step_no !== undefined && m.step_no !== where.step_no) return false;
        if (where?.status && m.status !== where.status) return false;
        if (where?.reply_category && m.reply_category !== where.reply_category) return false;
        if (where?.email_account_id && m.email_account_id !== where.email_account_id) return false;
        if (where?.recipient_id && m.recipient_id !== where.recipient_id) return false;
        return true;
      })[0] || null;
    },
    create: async ({ data }: any) => localDevStore.saveEmailMessage(data),
    update: async ({ where, data }: any) => {
      const existing = localDevStore.getEmailMessages((m) => m.id === where.id)[0] || { id: where.id };
      return localDevStore.saveEmailMessage({ ...existing, ...data });
    },
    deleteMany: async ({ where }: any = {}) => {
      return localDevStore.deleteWhere("email_messages", (m) => !where?.user_id || m.user_id === where.user_id);
    },
    count: async ({ where }: any = {}) => {
      return localDevStore.getEmailMessages((m) => {
        if (where?.user_id && m.user_id !== where.user_id) return false;
        if (where?.direction && m.direction !== where.direction) return false;
        if (where?.reply_category && m.reply_category !== where.reply_category) return false;
        if (where?.email_account_id && m.email_account_id !== where.email_account_id) return false;
        if (where?.status && m.status !== where.status) return false;
        if (where?.sent_at?.gte) {
          const since = new Date(where.sent_at.gte).getTime();
          const sent = new Date(m.sent_at).getTime();
          if (sent < since) return false;
        }
        return true;
      }).length;
    },
  };

  followup_sequences = {
    findMany: async ({ where, take, skip }: any = {}) => {
      let items = localDevStore.getFollowupSequences((s) => {
        if (where?.user_id && s.user_id !== where.user_id) return false;
        if (where?.campaign_id && s.campaign_id !== where.campaign_id) return false;
        return true;
      });
      if (skip && typeof skip === "number") items = items.slice(skip);
      if (take && typeof take === "number") items = items.slice(0, take);
      return items;
    },
    findFirst: async ({ where }: any = {}) => {
      return localDevStore.findFollowupSequence((s) => (!where?.campaign_id || s.campaign_id === where.campaign_id) && (!where?.id || s.id === where.id));
    },
    findUnique: async ({ where }: any = {}) => {
      return localDevStore.findFollowupSequence((s) => s.id === where.id);
    },
    create: async ({ data }: any) => localDevStore.saveFollowupSequence(data),
    update: async ({ where, data }: any) => {
      const existing = localDevStore.findFollowupSequence((s) => s.id === where.id || s.campaign_id === where.campaign_id);
      return localDevStore.saveFollowupSequence({ ...existing, ...data });
    },
    delete: async ({ where }: any) => {
      return { id: where.id };
    },
    deleteMany: async ({ where }: any = {}) => {
      return localDevStore.deleteWhere("followup_sequences", (s) => !where?.user_id || s.user_id === where.user_id);
    },
  };

  campaign_steps = {
    findMany: async ({ where, orderBy }: any = {}) => {
      let items = localDevStore.getCampaignSteps((s: any) => {
        if (where?.campaign_id && s.campaign_id !== where.campaign_id) return false;
        if (where?.step_no && s.step_no !== where.step_no) return false;
        return true;
      });
      if (orderBy?.step_no === "asc") items = [...items].sort((a, b) => a.step_no - b.step_no);
      return items;
    },
    findFirst: async ({ where }: any = {}) => {
      return localDevStore.findCampaignStep((s: any) => {
        if (where?.campaign_id && s.campaign_id !== where.campaign_id) return false;
        if (where?.step_no && s.step_no !== where.step_no) return false;
        return true;
      });
    },
    create: async ({ data }: any) => localDevStore.saveCampaignStep(data),
    createMany: async ({ data }: any) => {
      if (Array.isArray(data)) {
        data.forEach((d) => localDevStore.saveCampaignStep(d));
      }
      return { count: Array.isArray(data) ? data.length : 0 };
    },
    deleteMany: async ({ where }: any = {}) => {
      return localDevStore.deleteCampaignSteps((s: any) => !where?.campaign_id || s.campaign_id === where.campaign_id);
    },
  };

  campaign_variants = {
    findMany: async ({ where, orderBy }: any = {}) => {
      let items = localDevStore.getCampaignVariants((v: any) => {
        if (where?.campaign_id && v.campaign_id !== where.campaign_id) return false;
        if (where?.step_no !== undefined && v.step_no !== where.step_no) return false;
        if (where?.is_active !== undefined && v.is_active !== where.is_active) return false;
        return true;
      });
      if (orderBy?.label === "asc") items = [...items].sort((a, b) => String(a.label).localeCompare(String(b.label)));
      return items;
    },
    findFirst: async ({ where }: any = {}) => {
      return localDevStore.findCampaignVariant((v: any) => {
        if (where?.id && v.id !== where.id) return false;
        if (where?.campaign_id && v.campaign_id !== where.campaign_id) return false;
        if (where?.step_no !== undefined && v.step_no !== where.step_no) return false;
        if (where?.is_active !== undefined && v.is_active !== where.is_active) return false;
        return true;
      });
    },
    findUnique: async ({ where }: any = {}) => {
      return localDevStore.findCampaignVariant((v: any) => v.id === where.id);
    },
    create: async ({ data }: any) => localDevStore.saveCampaignVariant(data),
    createMany: async ({ data }: any) => {
      if (Array.isArray(data)) {
        data.forEach((d) => localDevStore.saveCampaignVariant(d));
      }
      return { count: Array.isArray(data) ? data.length : 0 };
    },
    update: async ({ where, data }: any) => {
      const existing = localDevStore.findCampaignVariant((v: any) => v.id === where.id);
      return localDevStore.saveCampaignVariant({ ...existing, ...data });
    },
    delete: async ({ where }: any) => {
      localDevStore.deleteCampaignVariant(where.id);
      return { id: where.id };
    },
    deleteMany: async ({ where }: any = {}) => {
      return localDevStore.deleteWhere("campaign_variants", (v) => {
        if (where?.campaign_id?.in && Array.isArray(where.campaign_id.in)) {
          return where.campaign_id.in.includes(v.campaign_id);
        }
        if (where?.campaign_id) return v.campaign_id === where.campaign_id;
        return true;
      });
    },
  };

  tracking_events = {
    findMany: async ({ where, take, orderBy }: any = {}) => {
      let items = localDevStore.getTrackingEvents((e: any) => {
        if (where?.campaign_id && e.campaign_id !== where.campaign_id) return false;
        if (where?.recipient_id && e.recipient_id !== where.recipient_id) return false;
        if (where?.variant_id !== undefined) {
          if (where.variant_id?.not === null && (e.variant_id === null || e.variant_id === undefined)) return false;
          else if (typeof where.variant_id === "string" && e.variant_id !== where.variant_id) return false;
        }
        if (where?.event_type && e.event_type !== where.event_type) return false;
        return true;
      });
      if (take) items = items.slice(0, take);
      return items;
    },
    create: async ({ data }: any) => localDevStore.saveTrackingEvent(data),
    deleteMany: async ({ where }: any = {}) => {
      return localDevStore.deleteWhere("tracking_events", (e) => {
        if (where?.campaign_id?.in && Array.isArray(where.campaign_id.in)) {
          return where.campaign_id.in.includes(e.campaign_id);
        }
        if (where?.campaign_id) return e.campaign_id === where.campaign_id;
        return true;
      });
    },
    count: async ({ where }: any = {}) => {
      return localDevStore.getTrackingEvents((e: any) => {
        if (where?.campaign_id && e.campaign_id !== where.campaign_id) return false;
        if (where?.variant_id && e.variant_id !== where.variant_id) return false;
        if (where?.event_type && e.event_type !== where.event_type) return false;
        return true;
      }).length;
    },
  };

  tracking_domains = {
    findMany: async ({ where, take, skip, orderBy }: any = {}) => {
      let items = localDevStore.getTrackingDomains((d: any) => {
        if (where?.user_id && d.user_id !== where.user_id) return false;
        if (where?.status && d.status !== where.status) return false;
        if (where?.domain && d.domain !== where.domain) return false;
        if (where?.is_default !== undefined && d.is_default !== where.is_default) return false;
        return true;
      });
      if (orderBy?.created_at === "desc") {
        items = [...items].sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
      }
      if (skip) items = items.slice(skip);
      if (take) items = items.slice(0, take);
      return items;
    },
    findFirst: async ({ where }: any = {}) => {
      return localDevStore.findTrackingDomain((d: any) => {
        if (where?.id && d.id !== where.id) return false;
        if (where?.user_id && d.user_id !== where.user_id) return false;
        if (where?.domain && d.domain !== where.domain) return false;
        if (where?.status && d.status !== where.status) return false;
        if (where?.is_default !== undefined && d.is_default !== where.is_default) return false;
        return true;
      });
    },
    findUnique: async ({ where }: any = {}) => {
      return localDevStore.findTrackingDomain((d: any) => {
        if (where?.id && d.id !== where.id) return false;
        if (where?.domain && d.domain !== where.domain) return false;
        return true;
      });
    },
    create: async ({ data }: any) => localDevStore.saveTrackingDomain(data),
    update: async ({ where, data }: any) => {
      const existing = localDevStore.findTrackingDomain((d: any) => d.id === where.id);
      return localDevStore.saveTrackingDomain({ ...existing, ...data });
    },
    updateMany: async ({ where, data }: any) => {
      const matching = localDevStore.getTrackingDomains((d: any) => {
        if (where?.user_id && d.user_id !== where.user_id) return false;
        if (where?.id?.not && d.id === where.id.not) return false;
        return true;
      });
      matching.forEach((m: any) => localDevStore.saveTrackingDomain({ ...m, ...data }));
      return { count: matching.length };
    },
    delete: async ({ where }: any) => {
      localDevStore.deleteTrackingDomain(where.id);
      return { id: where.id };
    },
    deleteMany: async ({ where }: any = {}) => {
      return localDevStore.deleteWhere("tracking_domains", (d) => !where?.user_id || d.user_id === where.user_id);
    },
    count: async ({ where }: any = {}) => {
      return localDevStore.getTrackingDomains((d: any) => {
        if (where?.user_id && d.user_id !== where.user_id) return false;
        if (where?.status && d.status !== where.status) return false;
        return true;
      }).length;
    },
  };

  warmup_logs = {
    findMany: async ({ where, include, take, skip, orderBy }: any = {}) => {
      let items = localDevStore.getWarmupLogs((w: any) => {
        if (where?.id && w.id !== where.id) return false;
        if (where?.user_id && w.user_id !== where.user_id) return false;
        if (where?.from_account_id && w.from_account_id !== where.from_account_id) return false;
        if (where?.to_account_id && w.to_account_id !== where.to_account_id) return false;
        if (where?.status) {
          if (Array.isArray(where.status?.in) && !where.status.in.includes(w.status)) return false;
          if (typeof where.status === "string" && w.status !== where.status) return false;
        }
        if (where?.sent_at?.gte) {
          if (new Date(w.sent_at).getTime() < new Date(where.sent_at.gte).getTime()) return false;
        }
        return true;
      });
      if (orderBy?.sent_at === "desc" || orderBy?.created_at === "desc") {
        items = [...items].sort(
          (a, b) => new Date(b.sent_at || b.created_at).getTime() - new Date(a.sent_at || a.created_at).getTime()
        );
      }
      if (skip) items = items.slice(skip);
      if (take) items = items.slice(0, take);
      if (include) {
        return items.map((w: any) => ({
          ...w,
          from_account: include.from_account
            ? localDevStore.findEmailAccount((a: any) => a.id === w.from_account_id)
            : undefined,
          to_account: include.to_account
            ? localDevStore.findEmailAccount((a: any) => a.id === w.to_account_id)
            : undefined,
        }));
      }
      return items;
    },
    findFirst: async ({ where }: any = {}) => {
      return localDevStore.findWarmupLog((w: any) => {
        if (where?.id && w.id !== where.id) return false;
        if (where?.user_id && w.user_id !== where.user_id) return false;
        if (where?.from_account_id && w.from_account_id !== where.from_account_id) return false;
        if (where?.to_account_id && w.to_account_id !== where.to_account_id) return false;
        if (where?.status && w.status !== where.status) return false;
        if (where?.message_id) {
          if (Array.isArray(where.message_id?.in) && !where.message_id.in.includes(w.message_id)) return false;
          if (typeof where.message_id === "string" && w.message_id !== where.message_id) return false;
        }
        if (Array.isArray(where?.OR)) {
          const matchesAny = where.OR.some((clause: any) => {
            if (clause.id && w.id === clause.id) return true;
            if (clause.message_id && typeof clause.message_id === "string" && w.message_id === clause.message_id) return true;
            if (Array.isArray(clause.message_id?.in) && clause.message_id.in.includes(w.message_id)) return true;
            return false;
          });
          if (!matchesAny) return false;
        }
        return true;
      });
    },
    create: async ({ data }: any) => localDevStore.saveWarmupLog(data),
    update: async ({ where, data }: any) => {
      const existing = localDevStore.findWarmupLog((w: any) => w.id === where.id);
      return localDevStore.saveWarmupLog({ ...existing, ...data });
    },
    updateMany: async ({ where, data }: any) => {
      const matching = localDevStore.getWarmupLogs((w: any) => {
        if (where?.id && w.id !== where.id) return false;
        if (where?.user_id && w.user_id !== where.user_id) return false;
        if (where?.status && w.status !== where.status) return false;
        return true;
      });
      matching.forEach((m: any) => localDevStore.saveWarmupLog({ ...m, ...data }));
      return { count: matching.length };
    },
    deleteMany: async ({ where }: any = {}) => {
      return localDevStore.deleteWhere("warmup_logs", (w) => !where?.user_id || w.user_id === where.user_id);
    },
    count: async ({ where }: any = {}) => {
      return localDevStore.getWarmupLogs((w: any) => {
        if (where?.user_id && w.user_id !== where.user_id) return false;
        if (where?.from_account_id && w.from_account_id !== where.from_account_id) return false;
        if (where?.to_account_id && w.to_account_id !== where.to_account_id) return false;
        if (where?.status) {
          if (Array.isArray(where.status?.in) && !where.status.in.includes(w.status)) return false;
          if (typeof where.status === "string" && w.status !== where.status) return false;
        }
        if (where?.sent_at?.gte) {
          if (new Date(w.sent_at).getTime() < new Date(where.sent_at.gte).getTime()) return false;
        }
        if (where?.replied_at?.gte) {
          if (!w.replied_at || new Date(w.replied_at).getTime() < new Date(where.replied_at.gte).getTime()) return false;
        }
        return true;
      }).length;
    },
  };

  lead_searches = {
    create: async ({ data }: any) => localDevStore.saveLeadSearch(data),
    update: async ({ where, data }: any) => {
      const existing = localDevStore.findLeadSearch((s) => s.id === where.id);
      return localDevStore.saveLeadSearch({ ...existing, ...data });
    },
    findMany: async ({ where, orderBy }: any = {}) => {
      const items = localDevStore.getLeadSearches((s) => !where?.user_id || s.user_id === where.user_id);
      return items;
    },
    findFirst: async ({ where }: any = {}) => {
      return localDevStore.findLeadSearch((s) => (!where?.user_id || s.user_id === where.user_id) && (!where?.id || s.id === where.id));
    },
    findUnique: async ({ where }: any = {}) => {
      return localDevStore.findLeadSearch((s) => s.id === where.id);
    },
    count: async ({ where }: any = {}) => {
      return localDevStore.getLeadSearches((s) => !where?.user_id || s.user_id === where.user_id).length;
    },
  };

  apify_usage_logs = {
    create: async ({ data }: any) => localDevStore.saveApifyUsageLog(data),
    findMany: async ({ where, take, orderBy }: any = {}) => {
      let items = localDevStore.getApifyUsageLogs((l) => !where?.user_id || l.user_id === where.user_id);
      if (orderBy?.created_at === "desc") {
        items = [...items].sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
      }
      if (take) items = items.slice(0, take);
      return items;
    },
    count: async ({ where }: any = {}) => {
      return localDevStore.getApifyUsageLogs((l) => !where?.user_id || l.user_id === where.user_id).length;
    },
  };

  leads = {
    create: async ({ data }: any) => localDevStore.saveLead(data),
    update: async ({ where, data }: any) => {
      return localDevStore.updateLead(where.id, data);
    },
    findMany: async ({ where, take, skip, orderBy }: any = {}) => {
      let items = localDevStore.getLeads((l) => {
        if (where?.user_id && l.user_id !== where.user_id) return false;
        if (where?.search_id && l.search_id !== where.search_id) return false;
        if (where?.status && l.status !== where.status) return false;
        if (where?.id?.in && Array.isArray(where.id.in) && !where.id.in.includes(l.id)) return false;
        return true;
      });
      if (orderBy?.collected_at === "desc") {
        items = [...items].sort((a, b) => new Date(b.collected_at || 0).getTime() - new Date(a.collected_at || 0).getTime());
      }
      if (skip && typeof skip === "number") {
        items = items.slice(skip);
      }
      if (take && typeof take === "number") {
        items = items.slice(0, take);
      }
      return items;
    },
    findFirst: async ({ where }: any = {}) => {
      return localDevStore.findLead((l) => (!where?.user_id || l.user_id === where.user_id) && (!where?.id || l.id === where.id));
    },
    findUnique: async ({ where }: any = {}) => {
      return localDevStore.findLead((l) => l.id === where.id);
    },
    deleteMany: async ({ where }: any = {}) => {
      return localDevStore.deleteWhere("leads", (l) => !where?.user_id || l.user_id === where.user_id);
    },
    count: async ({ where }: any = {}) => {
      return localDevStore.getLeads((l) => {
        if (where?.user_id && l.user_id !== where.user_id) return false;
        if (where?.search_id && l.search_id !== where.search_id) return false;
        if (where?.id?.in && Array.isArray(where.id.in) && !where.id.in.includes(l.id)) return false;
        return true;
      }).length;
    },
  };

  social_campaigns = {
    findMany: async ({ where, include }: any = {}) => {
      const items = localDevStore.getCampaigns(
        (c) => (!where?.user_id || c.user_id === where.user_id) && (!where?.status || c.status === where.status)
      );
      if (include?.social_account) {
        return items.map((c) => ({
          ...c,
          social_account: localDevStore.findSocialAccount((a) => a.id === c.social_account_id),
        }));
      }
      return items;
    },
    findFirst: async ({ where, include }: any = {}) => {
      const c = localDevStore.findCampaign(
        (c) => (!where?.user_id || c.user_id === where.user_id) && (!where?.id || c.id === where.id)
      );
      if (c && include?.social_account) {
        return {
          ...c,
          social_account: localDevStore.findSocialAccount((a) => a.id === c.social_account_id),
        };
      }
      return c;
    },
    findUnique: async ({ where, include }: any = {}) => {
      const c = localDevStore.findCampaign((c) => c.id === where.id);
      if (c && include?.social_account) {
        return {
          ...c,
          social_account: localDevStore.findSocialAccount((a) => a.id === c.social_account_id),
        };
      }
      return c;
    },
    create: async ({ data }: any) => {
      return localDevStore.saveCampaign(data);
    },
    update: async ({ where, data }: any) => {
      const existing = localDevStore.findCampaign((c) => c.id === where.id);
      return localDevStore.saveCampaign({ ...existing, ...data });
    },
    delete: async ({ where }: any) => {
      localDevStore.deleteCampaign(where.id, where.user_id);
      return { id: where.id };
    },
    updateMany: async ({ where, data }: any = {}) => {
      const items = localDevStore.getCampaigns((c) => (!where?.user_id || c.user_id === where.user_id) && (!where?.status || c.status === where.status));
      for (const item of items) {
        localDevStore.saveCampaign({ ...item, ...data });
      }
      return { count: items.length };
    },
    count: async ({ where }: any = {}) => {
      return localDevStore.getCampaigns(where?.user_id ? (c) => c.user_id === where.user_id : undefined).length;
    },
  };

  post_runs = {
    findMany: async ({ where, include, take }: any = {}) => {
      let items = localDevStore.getPostRuns(
        (p) => (!where?.user_id || p.user_id === where.user_id) && (!where?.status || p.status === where.status)
      );
      if (take) items = items.slice(0, take);
      if (include?.campaign) {
        return items.map((p) => {
          const camp = localDevStore.findCampaign((c) => c.id === p.campaign_id);
          return {
            ...p,
            campaign: camp
              ? {
                  ...camp,
                  social_account: localDevStore.findSocialAccount((a) => a.id === camp.social_account_id),
                }
              : null,
          };
        });
      }
      return items;
    },
    findFirst: async ({ where, include }: any = {}) => {
      const p = localDevStore.findPostRun((item) => (!where?.id || item.id === where.id) && (!where?.user_id || item.user_id === where.user_id));
      if (p && include?.campaign) {
        const camp = localDevStore.findCampaign((c) => c.id === p.campaign_id);
        return {
          ...p,
          campaign: camp
            ? {
                ...camp,
                social_account: localDevStore.findSocialAccount((a) => a.id === camp.social_account_id),
              }
            : null,
        };
      }
      return p;
    },
    findUnique: async ({ where, include }: any = {}) => {
      const p = localDevStore.findPostRun((item) => item.id === where.id);
      if (p && include?.campaign) {
        const camp = localDevStore.findCampaign((c) => c.id === p.campaign_id);
        return {
          ...p,
          campaign: camp
            ? {
                ...camp,
                social_account: localDevStore.findSocialAccount((a) => a.id === camp.social_account_id),
              }
            : null,
        };
      }
      return p;
    },
    create: async ({ data }: any) => {
      return localDevStore.savePostRun(data);
    },
    update: async ({ where, data }: any) => {
      const existing = localDevStore.findPostRun((p) => p.id === where.id);
      return localDevStore.savePostRun({ ...existing, ...data });
    },
    upsert: async ({ where, create, update }: any) => {
      const existing = localDevStore.findPostRun(
        (p) => p.campaign_id === where.campaign_id_scheduled_for?.campaign_id
      );
      if (existing) {
        return localDevStore.savePostRun({ ...existing, ...update });
      }
      return localDevStore.savePostRun(create);
    },
    delete: async ({ where }: any) => {
      localDevStore.deletePostRun(where.id, where.user_id);
      return { id: where.id };
    },
    updateMany: async ({ where, data }: any = {}) => {
      const items = localDevStore.getPostRuns((p) => {
        if (where?.user_id && p.user_id !== where.user_id) return false;
        if (where?.status) {
          if (where.status.in && Array.isArray(where.status.in)) {
            if (!where.status.in.includes(p.status)) return false;
          } else if (p.status !== where.status) {
            return false;
          }
        }
        if (where?.scheduled_for?.lt && p.scheduled_for) {
          if (new Date(p.scheduled_for) >= new Date(where.scheduled_for.lt)) return false;
        }
        return true;
      });
      for (const item of items) {
        localDevStore.savePostRun({ ...item, ...data });
      }
      return { count: items.length };
    },
    count: async ({ where }: any = {}) => {
      return localDevStore.getPostRuns(where?.user_id ? (p) => p.user_id === where.user_id : undefined).length;
    },
  };

  admin_audit_logs = {
    findMany: async ({ where, take, skip, orderBy, include }: any = {}) => {
      let items = localDevStore.getAuditLogs((l) => {
        if (where?.admin_id && l.admin_id !== where.admin_id) return false;
        if (where?.action && l.action !== where.action) return false;
        if (where?.created_at?.gte && new Date(l.created_at) < new Date(where.created_at.gte)) return false;
        if (where?.created_at?.lt && new Date(l.created_at) >= new Date(where.created_at.lt)) return false;
        return true;
      });
      if (orderBy?.created_at === "desc") {
        items = [...items].sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
      }
      if (skip && typeof skip === "number") items = items.slice(skip);
      if (take && typeof take === "number") items = items.slice(0, take);
      if (include?.admin) {
        items = items.map((l) => ({
          ...l,
          admin: localDevStore.findUser((u) => u.id === l.admin_id) || null,
        }));
      }
      return items;
    },
    create: async ({ data }: any) => localDevStore.saveAuditLog(data),
    count: async ({ where }: any = {}) => {
      return localDevStore.getAuditLogs((l) => {
        if (where?.admin_id && l.admin_id !== where.admin_id) return false;
        if (where?.action && l.action !== where.action) return false;
        if (where?.created_at?.gte && new Date(l.created_at) < new Date(where.created_at.gte)) return false;
        if (where?.created_at?.lt && new Date(l.created_at) >= new Date(where.created_at.lt)) return false;
        return true;
      }).length;
    },
    deleteMany: async ({ where }: any = {}) => {
      return localDevStore.deleteAuditLogs((l) => {
        if (where?.created_at?.lt && new Date(l.created_at) < new Date(where.created_at.lt)) return true;
        return false;
      });
    },
  };

  activity_logs = {
    findMany: async ({ where, take, skip, orderBy, include }: any = {}) => {
      let items = localDevStore.getActivityLogs((l) => {
        if (where?.user_id && l.user_id !== where.user_id) return false;
        if (where?.type && l.type !== where.type) return false;
        if (where?.created_at?.gte && new Date(l.created_at) < new Date(where.created_at.gte)) return false;
        if (where?.created_at?.lt && new Date(l.created_at) >= new Date(where.created_at.lt)) return false;
        return true;
      });
      if (orderBy?.created_at === "desc") {
        items = [...items].sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
      }
      if (skip && typeof skip === "number") items = items.slice(skip);
      if (take && typeof take === "number") items = items.slice(0, take);
      if (include?.user) {
        items = items.map((l) => ({
          ...l,
          user: localDevStore.findUser((u) => u.id === l.user_id) || null,
        }));
      }
      return items;
    },
    create: async ({ data }: any) => localDevStore.saveActivityLog(data),
    count: async ({ where }: any = {}) => {
      return localDevStore.getActivityLogs((l) => {
        if (where?.user_id && l.user_id !== where.user_id) return false;
        if (where?.type && l.type !== where.type) return false;
        if (where?.created_at?.gte && new Date(l.created_at) < new Date(where.created_at.gte)) return false;
        if (where?.created_at?.lt && new Date(l.created_at) >= new Date(where.created_at.lt)) return false;
        return true;
      }).length;
    },
    deleteMany: async ({ where }: any = {}) => {
      return localDevStore.deleteActivityLogs((l) => {
        if (where?.created_at?.lt && new Date(l.created_at) < new Date(where.created_at.lt)) return true;
        return false;
      });
    },
  };

  plans = {
    findMany: async ({ where, orderBy, take, skip }: any = {}) => {
      let items = localDevStore.getPlans((p) => {
        if (where?.is_active !== undefined && p.is_active !== where.is_active) return false;
        if (where?.slug && p.slug !== where.slug) return false;
        return true;
      });
      if (orderBy?.created_at === "desc") {
        items = [...items].sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
      } else if (orderBy?.monthly_price === "asc") {
        items = [...items].sort((a, b) => Number(a.monthly_price || 0) - Number(b.monthly_price || 0));
      }
      if (skip && typeof skip === "number") items = items.slice(skip);
      if (take && typeof take === "number") items = items.slice(0, take);
      return items;
    },
    findUnique: async ({ where }: any = {}) => {
      return localDevStore.findPlan((p) => (where?.id && p.id === where.id) || (where?.slug && p.slug === where.slug));
    },
    findFirst: async ({ where }: any = {}) => {
      return localDevStore.findPlan((p) => (where?.id && p.id === where.id) || (where?.slug && p.slug === where.slug));
    },
    create: async ({ data }: any) => localDevStore.savePlan(data),
    update: async ({ where, data }: any) => localDevStore.updatePlan(where.id || where.slug, data),
    delete: async ({ where }: any) => localDevStore.deletePlan(where.id || where.slug),
    count: async ({ where }: any = {}) => {
      return localDevStore.getPlans((p) => {
        if (where?.is_active !== undefined && p.is_active !== where.is_active) return false;
        if (where?.slug && p.slug !== where.slug) return false;
        return true;
      }).length;
    },
  };

  user_limit_overrides = {
    findUnique: async ({ where }: any = {}) => {
      return localDevStore.findUserLimitOverride((o) => (where?.id && o.id === where.id) || (where?.user_id && o.user_id === where.user_id));
    },
    findFirst: async ({ where }: any = {}) => {
      return localDevStore.findUserLimitOverride((o) => (where?.id && o.id === where.id) || (where?.user_id && o.user_id === where.user_id));
    },
    upsert: async ({ where, create, update }: any = {}) => {
      const existing = localDevStore.findUserLimitOverride((o) => o.user_id === where.user_id);
      if (existing) {
        return localDevStore.saveUserLimitOverride({ ...existing, ...update });
      }
      return localDevStore.saveUserLimitOverride(create);
    },
    create: async ({ data }: any) => localDevStore.saveUserLimitOverride(data),
    update: async ({ where, data }: any) => localDevStore.saveUserLimitOverride({ ...where, ...data }),
    delete: async ({ where }: any) => localDevStore.deleteUserLimitOverride(where.user_id),
  };

  usage_counters = {
    findMany: async ({ where, orderBy, take, skip }: any = {}) => {
      let items = localDevStore.getUsageCounters((c) => {
        if (where?.user_id && c.user_id !== where.user_id) return false;
        if (where?.resource && c.resource !== where.resource) return false;
        if (where?.period && c.period !== where.period) return false;
        return true;
      });
      if (orderBy?.quantity === "desc") {
        items = [...items].sort((a, b) => (b.quantity || 0) - (a.quantity || 0));
      } else if (orderBy?.updated_at === "desc") {
        items = [...items].sort((a, b) => new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime());
      }
      if (skip && typeof skip === "number") items = items.slice(skip);
      if (take && typeof take === "number") items = items.slice(0, take);
      return items;
    },
    findUnique: async ({ where }: any = {}) => {
      return localDevStore.findUsageCounter((c) => {
        if (where?.id && c.id === where.id) return true;
        if (where?.user_id_resource_period) {
          return (
            c.user_id === where.user_id_resource_period.user_id &&
            c.resource === where.user_id_resource_period.resource &&
            c.period === where.user_id_resource_period.period
          );
        }
        return false;
      });
    },
    findFirst: async ({ where }: any = {}) => {
      return localDevStore.findUsageCounter((c) => {
        if (where?.id && c.id === where.id) return true;
        if (where?.user_id && c.user_id !== where.user_id) return false;
        if (where?.resource && c.resource !== where.resource) return false;
        if (where?.period && c.period !== where.period) return false;
        return true;
      });
    },
    upsert: async ({ where, create, update }: any = {}) => {
      const match = where?.user_id_resource_period || where;
      const existing = localDevStore.findUsageCounter((c) => {
        return c.user_id === match.user_id && c.resource === match.resource && c.period === match.period;
      });
      if (existing) {
        const incrementVal = update?.quantity?.increment;
        const newQty = incrementVal !== undefined ? (existing.quantity || 0) + incrementVal : (update?.quantity ?? existing.quantity);
        return localDevStore.saveUsageCounter({ ...existing, ...update, quantity: newQty, updated_at: new Date().toISOString() });
      }
      return localDevStore.saveUsageCounter({
        user_id: match.user_id || create.user_id,
        resource: match.resource || create.resource,
        period: match.period || create.period,
        quantity: create.quantity || 0,
        ...create,
      });
    },
    create: async ({ data }: any) => localDevStore.saveUsageCounter(data),
    update: async ({ where, data }: any) => {
      const existing = localDevStore.findUsageCounter((c) => c.id === where.id);
      return localDevStore.saveUsageCounter({ ...existing, ...data });
    },
    count: async ({ where }: any = {}) => {
      return localDevStore.getUsageCounters((c) => {
        if (where?.user_id && c.user_id !== where.user_id) return false;
        if (where?.resource && c.resource !== where.resource) return false;
        if (where?.period && c.period !== where.period) return false;
        return true;
      }).length;
    },
    deleteMany: async ({ where }: any = {}) => {
      return localDevStore.deleteUsageCounters((c) => {
        if (where?.period && c.period !== where.period) return false;
        if (where?.user_id && c.user_id !== where.user_id) return false;
        return true;
      });
    },
  };

  subscriptions = {
    findMany: async ({ where, orderBy, take, skip }: any = {}) => {
      let items = localDevStore.getSubscriptions((s) => {
        if (where?.user_id && s.user_id !== where.user_id) return false;
        if (where?.status && s.status !== where.status) return false;
        if (where?.plan_id && s.plan_id !== where.plan_id) return false;
        return true;
      });
      if (orderBy?.created_at === "desc") {
        items = [...items].sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
      }
      if (skip && typeof skip === "number") items = items.slice(skip);
      if (take && typeof take === "number") items = items.slice(0, take);
      return items;
    },
    findFirst: async ({ where }: any = {}) => {
      return localDevStore.findSubscription((s) => {
        if (where?.id && s.id !== where.id) return false;
        if (where?.user_id && s.user_id !== where.user_id) return false;
        if (where?.status && s.status !== where.status) return false;
        if (where?.provider_subscription_id && s.provider_subscription_id !== where.provider_subscription_id) return false;
        return true;
      });
    },
    findUnique: async ({ where }: any = {}) => {
      return localDevStore.findSubscription((s) => s.id === where.id);
    },
    create: async ({ data }: any) => localDevStore.saveSubscription(data),
    update: async ({ where, data }: any) => {
      const existing = localDevStore.findSubscription((s) => s.id === where.id);
      return localDevStore.saveSubscription({ ...existing, ...data });
    },
    deleteMany: async ({ where }: any = {}) => {
      return localDevStore.deleteWhere("subscriptions", (s) => !where?.user_id || s.user_id === where.user_id);
    },
    count: async ({ where }: any = {}) => {
      return localDevStore.getSubscriptions((s) => {
        if (where?.user_id && s.user_id !== where.user_id) return false;
        if (where?.status && s.status !== where.status) return false;
        return true;
      }).length;
    },
  };

  payments = {
    findMany: async ({ where, orderBy, take, skip }: any = {}) => {
      let items = localDevStore.getPayments((p) => {
        if (where?.user_id && p.user_id !== where.user_id) return false;
        if (where?.status && p.status !== where.status) return false;
        if (where?.subscription_id && p.subscription_id !== where.subscription_id) return false;
        if (where?.provider && p.provider !== where.provider) return false;
        return true;
      });
      if (orderBy?.created_at === "desc") {
        items = [...items].sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
      }
      if (skip && typeof skip === "number") items = items.slice(skip);
      if (take && typeof take === "number") items = items.slice(0, take);
      return items;
    },
    findFirst: async ({ where }: any = {}) => {
      return localDevStore.findPayment((p) => {
        if (where?.id && p.id !== where.id) return false;
        if (where?.user_id && p.user_id !== where.user_id) return false;
        if (where?.invoice_number && p.invoice_number !== where.invoice_number) return false;
        if (where?.provider_payment_id && p.provider_payment_id !== where.provider_payment_id) return false;
        return true;
      });
    },
    findUnique: async ({ where }: any = {}) => {
      return localDevStore.findPayment((p) => p.id === where.id || (where.invoice_number && p.invoice_number === where.invoice_number));
    },
    create: async ({ data }: any) => localDevStore.savePayment(data),
    update: async ({ where, data }: any) => {
      const existing = localDevStore.findPayment((p) => p.id === where.id);
      return localDevStore.savePayment({ ...existing, ...data });
    },
    deleteMany: async ({ where }: any = {}) => {
      return localDevStore.deleteWhere("payments", (p) => !where?.user_id || p.user_id === where.user_id);
    },
    count: async ({ where }: any = {}) => {
      return localDevStore.getPayments((p) => {
        if (where?.user_id && p.user_id !== where.user_id) return false;
        if (where?.status && p.status !== where.status) return false;
        return true;
      }).length;
    },
  };

  processed_webhook_events = {
    findUnique: async ({ where }: any = {}) => {
      return localDevStore.findProcessedEvent((e) => {
        if (where?.id && e.id === where.id) return true;
        if (where?.provider_event_id) {
          return e.provider === where.provider_event_id.provider && e.event_id === where.provider_event_id.event_id;
        }
        return false;
      });
    },
    create: async ({ data }: any) => localDevStore.saveProcessedEvent(data),
  };

  error_logs = {
    findMany: async ({ where, orderBy, take, skip, include }: any = {}) => {
      let items = localDevStore.getErrorLogs((err) => {
        if (where?.source && err.source !== where.source) return false;
        if (where?.user_id && err.user_id !== where.user_id) return false;
        if (where?.created_at?.gte && new Date(err.created_at) < new Date(where.created_at.gte)) return false;
        if (where?.created_at?.lt && new Date(err.created_at) >= new Date(where.created_at.lt)) return false;
        return true;
      });
      if (orderBy?.created_at === "desc") {
        items = [...items].sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
      }
      if (skip && typeof skip === "number") items = items.slice(skip);
      if (take && typeof take === "number") items = items.slice(0, take);
      if (include?.user) {
        items = items.map((err) => ({
          ...err,
          user: err.user_id ? localDevStore.findUser((u) => u.id === err.user_id) : null,
        }));
      }
      return items;
    },
    findFirst: async ({ where }: any = {}) => {
      return localDevStore.findErrorLog((err) => {
        if (where?.id && err.id !== where.id) return false;
        return true;
      });
    },
    findUnique: async ({ where }: any = {}) => {
      return localDevStore.findErrorLog((err) => err.id === where.id);
    },
    create: async ({ data }: any) => localDevStore.saveErrorLog(data),
    update: async ({ where, data }: any) => localDevStore.updateErrorLog(where.id, data),
    count: async ({ where }: any = {}) => {
      return localDevStore.getErrorLogs((err) => {
        if (where?.source && err.source !== where.source) return false;
        if (where?.user_id && err.user_id !== where.user_id) return false;
        if (where?.created_at?.gte && new Date(err.created_at) < new Date(where.created_at.gte)) return false;
        return true;
      }).length;
    },
    deleteMany: async ({ where }: any = {}) => {
      return localDevStore.deleteErrorLogs((err) => {
        if (where?.created_at?.lt && new Date(err.created_at) < new Date(where.created_at.lt)) return true;
        return false;
      });
    },
  };

  apify_keys = {
    findMany: async ({ where, orderBy, take, skip }: any = {}) => {
      let items = localDevStore.getApifyKeys((k) => {
        if (where?.status && k.status !== where.status) return false;
        return true;
      });
      if (orderBy?.created_at === "desc") {
        items = [...items].sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
      }
      if (skip && typeof skip === "number") items = items.slice(skip);
      if (take && typeof take === "number") items = items.slice(0, take);
      return items;
    },
    findUnique: async ({ where }: any = {}) => {
      return localDevStore.findApifyKey((k) => k.id === where?.id);
    },
    findFirst: async ({ where }: any = {}) => {
      return localDevStore.findApifyKey((k) => {
        if (where?.status && k.status !== where.status) return false;
        return true;
      });
    },
    create: async ({ data }: any) => localDevStore.saveApifyKey(data),
    update: async ({ where, data }: any) => localDevStore.updateApifyKey(where?.id, data),
    delete: async ({ where }: any) => localDevStore.deleteApifyKey(where?.id),
    count: async ({ where }: any = {}) => {
      return localDevStore.getApifyKeys((k) => {
        if (where?.status && k.status !== where.status) return false;
        return true;
      }).length;
    },
  };

  $queryRaw = async () => [{ 1: 1 }];
  $transaction = async (arg: any) => {
    if (typeof arg === "function") {
      return arg(this);
    }
    return Promise.all(arg);
  };
}

export function createTestMockDb(): any {
  const instance: any = new LocalDevMockDb();
  const proxy: any = new Proxy(instance, {
    get(target, prop, receiver) {
      if (prop === "$transaction") {
        return async (arg: any) => {
          if (typeof arg === "function") {
            return arg(proxy);
          }
          return Promise.all(arg);
        };
      }
      const orig = Reflect.get(target, prop, receiver);
      if (orig !== undefined && typeof orig === "object" && orig !== null) {
        return new Proxy(orig, {
          get(subTarget, subProp, subReceiver) {
            const fn = Reflect.get(subTarget, subProp, subReceiver);
            if (fn !== undefined) return fn;
            return async () => {
              if (String(subProp).includes("findMany")) return [];
              if (String(subProp).includes("count")) return 0;
              if (String(subProp).includes("deleteMany") || String(subProp).includes("updateMany")) return { count: 0 };
              return null;
            };
          },
        });
      }
      if (orig !== undefined) return orig;
      return new Proxy({}, {
        get(_t, subProp) {
          return async () => {
            if (String(subProp).includes("findMany")) return [];
            if (String(subProp).includes("count")) return 0;
            if (String(subProp).includes("deleteMany") || String(subProp).includes("updateMany")) return { count: 0 };
            return null;
          };
        },
      });
    },
  });
  return proxy;
}

export function scoped<T extends object>(userId: string, where?: T): T & { user_id: string } {
  return { ...(where ?? ({} as T)), user_id: userId };
}
