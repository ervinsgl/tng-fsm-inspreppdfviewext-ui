/*global QUnit*/

sap.ui.define([
	"com/tng/fsm/inspreppdfviewext/app/controller/InspRepPDFViewExt.controller"
], function (Controller) {
	"use strict";

	QUnit.module("InspRepPDFViewExt Controller");

	QUnit.test("I should test the InspRepPDFViewExt controller", function (assert) {
		var oAppController = new Controller();
		oAppController.onInit();
		assert.ok(oAppController);
	});

});
