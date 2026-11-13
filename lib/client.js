window.__ModuleLoader__.load({
	id: "shipping-workbench",
	factory: (require) => {
		const react = require("react");

		const NS = "shipping.workbench";
		const zh = {
			"entry.label": "船期工作台",
		};
		const en = {
			"entry.label": "Shipping Workbench",
		};

		const PANEL_ID = "shipping-workbench";
		const WORKBENCH_URL = "/shipping-workbench/?embed=1";

		/** 侧栏面板列表里的小图标(点击由 sidebar 调 layout.selectPanel 切主区)。 */
		function WorkbenchGlyph({ size, active }) {
			return react.createElement(
				"span",
				{
					"aria-hidden": "true",
					style: {
						display: "inline-flex",
						alignItems: "center",
						justifyContent: "center",
						width: size ?? 16,
						height: size ?? 16,
						fontSize: (size ?? 16) - 1,
						lineHeight: 1,
						color: active ? "var(--dsw-alias-label-primary)" : "inherit",
					},
				},
				"⛴",
			);
		}

		/** 主区面板:整页 iframe,和工作台自己的路由/静态资源同源。 */
		function WorkbenchPanel() {
			return react.createElement(
				"div",
				{ style: { display: "flex", flex: 1, minHeight: 0, minWidth: 0, width: "100%" } },
				react.createElement("iframe", {
					src: WORKBENCH_URL,
					title: "船期工作台",
					style: { flex: 1, width: "100%", height: "100%", border: "0", display: "block", background: "transparent" },
				}),
			);
		}

		function apply(ctx) {
			try {
				ctx.effect(() => ctx.locale.register(NS, { zh, en }), "shipping-workbench: panel locale");
				const t = typeof ctx.locale.bind === "function" ? ctx.locale.bind(NS) : (key) => key;
				ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: PANEL_ID }, WorkbenchPanel));
				ctx.slots.inject("sidebar.panellist", () =>
					ctx.slots.register(
						{
							name: "sidebar.panellist",
							id: PANEL_ID,
							order: 5,
							locale: NS,
							label: () => t("entry.label"),
						},
						WorkbenchGlyph,
					),
				);
			} catch (error) {
				console.error("[shipping-workbench] 面板注册失败:", error);
			}
		}

		const inject = ["slots", "locale"];

		return { name: "shipping-workbench", inject, apply };
	},
});
