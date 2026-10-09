// dsh-web-search-session 浏览器半身
//
// 在侧栏「插件」页本插件自己的条目里挂一张配置卡片：第三方搜索平台的接口地址、
// API Key、以及"单次请求最多调用平台几次"。这三项都由界面写入宿主行的设置命名空间；密钥
// 例外——它经凭据服务落盘，引用名取 apiKeyEnv（留空时用该后端的默认名），因此
// 密钥不会出现在设置文件里，也不会有任何读路径把它带回浏览器。
//
// 约定：本文件的 lazy factory id 必须等于包名；React 从浏览器模块表取，不自带。
window.__ModuleLoader__.load({
  id: 'dsh-web-search-session',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var jsxRuntime = require('react/jsx-runtime');
    var jsx = jsxRuntime.jsx;
    var jsxs = jsxRuntime.jsxs;
    var primitives = require('@deepseek-ai/dsh-client-ui-primitives');

    /** 本插件自己的文案命名空间。 */
    var NS = 'settings.webSearchSession';

    /**
     * 包名。插件页的 plugins.bundle.config 槽按包名分格，注册用它当 key，
     * 卡片才会渲染在本插件自己的页面里（「已安装」分组），而不是挤进「官方」组。
     */
    var BUNDLE_NAME = 'dsh-web-search-session';

    /**
     * 宿主行的设置命名空间就是那一行的条目 id。客户端不得依赖宿主包，没法 import
     * 常量，所以把两种可能写法都列上，由 whileServed 回传的集合决定真实名字。
     */
    var NAMESPACE_CANDIDATES = ['web-search-session', 'dsh-web-search-session'];

    /** 各后端在 apiKeyEnv 留空时使用的默认凭据引用名（与宿主 BACKEND_DEFAULTS 一致）。 */
    var DEFAULT_KEY_REFS = { tavily: 'TAVILY_API_KEY', brave: 'BRAVE_API_KEY' };

    /** 简体中文文案。 */
    var zh = {
      title: '会话联网搜索',
      description: '让联网搜索跟随当前会话的模型：自建检索后端 + 会话模型改写检索词。',
      endpoint: '平台地址',
      endpointHint: '第三方搜索平台的接口地址，例如 http://127.0.0.1:8888；留空则用该后端的默认地址。',
      apiKey: 'API Key',
      apiKeyHint: '不写入设置文件，保存后交给凭据服务保管。留空表示保持当前密钥。',
      apiKeySet: '已配置密钥。',
      apiKeyUnset: '尚未配置密钥；该后端的密钥引用名为 {ref}。',
      apiKeyNotNeeded: '当前后端（{backend}）不需要密钥。',
      apiKeyReadOnly: '本部署不允许写入凭据。',
      maxQueries: '单次请求最多调用次数',
      maxQueriesHint: '一次搜索最多调用第三方平台几次（1–20），包含会话模型改写检索词后的多次检索。',
      overridden: '已覆盖',
      reset: '恢复默认',
      invalidNumber: '请填数字；留空表示使用默认值。',
      readOnly: '本部署的设置为只读。',
      unavailable: '该插件当前未加载，暂时无法配置。',
      save: '保存',
      saving: '保存中…',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
    };

    /** English copy. */
    var en = {
      title: 'Session web search',
      description: 'Web search that follows the current session model, backed by your own retrieval endpoint.',
      endpoint: 'Endpoint',
      endpointHint: 'Base URL of the third-party search platform, e.g. http://127.0.0.1:8888. Leave blank for the backend default.',
      apiKey: 'API key',
      apiKeyHint: 'Stored outside the settings file, in the credentials service. Leave blank to keep the current key.',
      apiKeySet: 'A key is configured.',
      apiKeyUnset: 'No key is configured; this backend reads the reference {ref}.',
      apiKeyNotNeeded: 'The current backend ({backend}) needs no key.',
      apiKeyReadOnly: 'This deployment does not accept credential writes.',
      maxQueries: 'Max platform calls per request',
      maxQueriesHint: 'How many times one search may call the third-party platform (1–20), including every planned query.',
      overridden: 'Overridden',
      reset: 'Reset to default',
      invalidNumber: 'Enter a number, or leave blank to use the default.',
      readOnly: 'This deployment stores settings read-only.',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
    };

    /** 表单骨架要的几句固定文案。 */
    function formLabels(t) {
      return {
        unavailable: t('unavailable'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving'),
      };
    }

    /** 渲染卡片：摘要视图只给一句话，明细视图给整张表单。 */
    function Card(props) {
      var t = props.t;
      var state = props.useWebSearchSessionCard((snapshot) => snapshot);
      if (props.view === 'summary') return t('description');
      var disabled = !state.writable;
      var keyDisabled = disabled || !state.apiKeyWritable;
      return jsxs(primitives.SettingsForm, {
        labels: formLabels(t),
        state: state,
        onSave: props.save,
        onDiscard: props.discard,
        children: [
          jsx(primitives.SettingsValueField, {
            id: 'plugin-config-web-search-session-endpoint',
            label: t('endpoint'),
            hint: t('endpointHint'),
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            invalidLabel: t('invalidNumber'),
            disabled: disabled,
            ...state.endpoint,
            onEdit: (text) => {
              props.edit('endpoint', text);
            },
            onReset: () => {
              props.resetField('endpoint');
            },
          }),
          jsx(primitives.SettingsSecretField, {
            id: 'plugin-config-web-search-session-key',
            label: t('apiKey'),
            hint: t('apiKeyHint'),
            disabled: keyDisabled,
            text: state.apiKey.text,
            configured: state.keyConfigured,
            stateLabel: state.keyStateLabel,
            onEdit: (text) => {
              props.edit('apiKey', text);
            },
          }),
          jsx(primitives.SettingsValueField, {
            id: 'plugin-config-web-search-session-max-queries',
            label: t('maxQueries'),
            hint: t('maxQueriesHint'),
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            invalidLabel: t('invalidNumber'),
            numeric: true,
            disabled: disabled,
            ...state.maxQueries,
            onEdit: (text) => {
              props.edit('maxQueries', text);
            },
            onReset: () => {
              props.resetField('maxQueries');
            },
          }),
        ],
      });
    }

    /** 表单里承载密钥的那一栏。 */
    var API_KEY_FIELD = 'apiKey';

    /**
     * 把某一行的设置作用域和凭据服务接到页面上。
     *
     * 地址与调用次数走设置命名空间，一键保存一起提交；密钥不在命名空间里，它的字面量
     * 从不随响应回来，页面只知道"配没配"，写入时按作用域当前声明的引用名走凭据服务。
     */
    function CardController(scope, ctx, t) {
      this.scope = scope;
      this.ctx = ctx;
      this.t = t;
      this.credential = { ref: '', configured: false, writable: true, backend: '' };
      this.form = new primitives.SettingsFormModel(
        scope,
        [primitives.settingsTextField('endpoint'), primitives.settingsNumberField('maxQueries')],
        [
          {
            field: API_KEY_FIELD,
            write: (text) => this.writeKey(text),
          },
        ],
      );
      this.store = this.form.bind(() => this.projection());
      this.unsubscribe = scope.subscribe(() => {
        this.readCredential();
      });
      this.readCredential();
    }

    CardController.prototype.projection = function projection() {
      return {
        ...this.form.shell(),
        endpoint: this.form.field('endpoint'),
        maxQueries: this.form.field('maxQueries'),
        apiKey: this.form.field(API_KEY_FIELD),
        keyConfigured: this.credential.configured,
        apiKeyWritable: this.credential.writable,
        keyStateLabel: this.keyStateLabel(),
      };
    };

    /** 密钥那一行右侧的状态说明。 */
    CardController.prototype.keyStateLabel = function keyStateLabel() {
      var t = this.t;
      if (this.credential.ref.length === 0) return t('apiKeyNotNeeded', { backend: this.credential.backend });
      if (!this.credential.writable) return t('apiKeyReadOnly');
      if (this.credential.configured) return t('apiKeySet');
      return t('apiKeyUnset', { ref: this.credential.ref });
    };

    /**
     * 问凭据服务：作用域当前声明的引用名配没配、能不能写。
     *
     * 答案跟着"它回答的那个引用名"一起存：apiKeyEnv 与 backend 都可能在一次请求和
     * 它的响应之间被改掉，两次读也会乱序落地，所以只有仍然对应当前引用名的响应才发布。
     */
    CardController.prototype.readCredential = async function readCredential() {
      var target = refOf(this.scope.getSnapshot());
      if (target.ref !== this.credential.ref || target.backend !== this.credential.backend) {
        this.credential = { ref: target.ref, backend: target.backend, configured: false, writable: target.ref.length > 0 };
        this.store.set(this.projection());
      }
      if (target.ref.length === 0) return;
      var response = await this.ctx.remote.credentials.describe([target.ref]);
      if (!response.ok || target.ref !== refOf(this.scope.getSnapshot()).ref) return;
      var view = response.value[target.ref];
      var next = {
        ref: target.ref,
        backend: target.backend,
        configured: view?.configured ?? false,
        writable: view?.writable ?? true,
      };
      if (next.configured === this.credential.configured && next.writable === this.credential.writable) return;
      this.credential = next;
      this.store.set(this.projection());
    };

    /** 宿主报告引用名有变化时重读；只关心自己盯着的那一个。 */
    CardController.prototype.refreshCredential = function refreshCredential(ref) {
      if (ref !== this.credential.ref) return;
      this.readCredential();
    };

    /** 页面 slot 注入的面：快照源 + 表单动作。 */
    CardController.prototype.inject = function inject() {
      return {
        hooks: { webSearchSessionCard: this.store },
        ...this.form.actions(),
      };
    };

    /** 写入暂存的密钥，然后重读宿主是否已持有。 */
    CardController.prototype.writeKey = async function writeKey(value) {
      var ref = refOf(this.scope.getSnapshot()).ref;
      if (ref.length === 0) return false;
      await this.ctx.remote.credentials.set(ref, value);
      await this.readCredential();
      return this.credential.configured;
    };

    CardController.prototype.dispose = function dispose() {
      this.unsubscribe();
      this.form.dispose();
    };

    /** 作用域当前指向的凭据引用名：apiKeyEnv 优先，留空则取该后端的默认名。 */
    function refOf(snapshot) {
      var value = snapshot?.value ?? {};
      var declared = typeof value.apiKeyEnv === 'string' ? value.apiKeyEnv.trim() : '';
      var backend = typeof value.backend === 'string' ? value.backend.trim().toLowerCase() : '';
      if (declared.length > 0) return { ref: declared, backend: backend };
      var fallback = Object.prototype.hasOwnProperty.call(DEFAULT_KEY_REFS, backend) ? DEFAULT_KEY_REFS[backend] : '';
      return { ref: fallback, backend: backend };
    }

    /** 必需服务（cordis fiber inject）。 */
    var inject = ['slots', 'locale', 'remote', 'remote.credentials', 'configForms'];

    /** 宿主服务起本插件的设置命名空间时，把卡片挂到本插件自己的插件页。 */
    function apply(ctx) {
      var t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh: zh, en: en }), 'web-search-session: dictionaries');

      var active = null;
      // 卡片控制器按命名空间缓存：宿主重载时该命名空间会短暂从 describe 列表消失，
      // whileServed 因此会注销再重挂。若在注销时就 dispose，用户暂存的输入与失败状态
      // 会被丢掉（表现为保存后数值弹回原样），故只在整条 effect 释放时才销毁。
      var cards = new Map();
      var cardFor = (ns) => {
        var cached = cards.get(ns);
        if (cached === undefined) {
          cached = new CardController(ctx.configForms.get(ns), ctx, t);
          cards.set(ns, cached);
        }
        return cached;
      };
      ctx.effect(
        () =>
          ctx.remote.$on('credentials/reference-updated', (ref) => {
            if (active !== null) active.refreshCredential(ref);
          }),
        'web-search-session: credential invalidations',
      );

      ctx.effect(() => {
        var off = ctx.configForms.whileServed(NAMESPACE_CANDIDATES, (served) => {
          var ns = NAMESPACE_CANDIDATES.find((name) => served.has(name));
          if (ns === undefined) return () => {};
          var card = cardFor(ns);
          var offSlot = ctx.slots.inject('plugins.bundle.config', () =>
            ctx.slots.register(
              {
                name: 'plugins.bundle.config',
                key: BUNDLE_NAME,
                locale: NS,
                inject: () => card.inject(),
              },
              Card,
            ),
          );
          active = card;
          return () => {
            if (active === card) active = null;
            offSlot();
          };
        });
        return () => {
          off();
          active = null;
          Array.from(cards.values()).forEach((card) => card.dispose());
          cards.clear();
        };
      }, 'web-search-session: page');
    }

    exports.NS = NS;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
