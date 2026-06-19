sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel"
], (Controller, JSONModel) => {
    "use strict";

    return Controller.extend("com.tns.fsm.inspreppdfviewext.app.controller.InspRepPDFViewExt", {

        onInit() {
            this.getView().setModel(new JSONModel({
                busy: true,
                showError: false,
                reportUrl: null,
                reportLoading: false,
                reportError: false
            }), "view");

            this._loadContext();
        },

        _loadContext() {
            const oModel = this.getView().getModel("view");

            // Session is delivered via HttpOnly fsm_session cookie set by the backend
            // on the FSM Mobile entry POST. The browser sends it automatically.
            fetch("/api/v1/context")
                .then(response => {
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    return response.json();
                })
                .then(context => {
                    // Set UI5 language from FSM context
                    if (context.language) {
                        sap.ui.getCore().getConfiguration().setLanguage(context.language);
                    }

                    oModel.setProperty("/busy", false);

                    if (context.cloudId) {
                        this._loadUdoValues(context.cloudId);
                    }
                })
                .catch(() => {
                    oModel.setProperty("/showError", true);
                    oModel.setProperty("/busy", false);
                });
        },

        _loadUdoValues(cloudId) {
            const oModel = this.getView().getModel("view");
            oModel.setProperty("/reportLoading", true);

            fetch(`/api/v1/udo-values?cloudId=${encodeURIComponent(cloudId)}`)
                .then(response => {
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    return response.json();
                })
                .then(data => {
                    if (data.checklistInstance && data.preliminaryReportTemplate) {
                        this._buildReport(data.checklistInstance, data.preliminaryReportTemplate);
                    } else {
                        oModel.setProperty("/reportError", true);
                        oModel.setProperty("/reportLoading", false);
                    }
                })
                .catch(() => {
                    oModel.setProperty("/reportError", true);
                    oModel.setProperty("/reportLoading", false);
                });
        },

        _buildReport(objectId, reportTemplateId) {
            const oModel = this.getView().getModel("view");
            const reportUrl = `/api/v1/build-report?objectId=${encodeURIComponent(objectId)}&reportTemplate=${encodeURIComponent(reportTemplateId)}&language=de`;
            oModel.setProperty("/reportUrl", reportUrl);
            oModel.setProperty("/reportLoading", false);
        }

    });
});