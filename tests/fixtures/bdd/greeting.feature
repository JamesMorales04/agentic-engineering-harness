@REQ-BDD
Feature: greeting

  Scenario: a greeting is returned
    Given a running provider
    When the greeting is requested
    Then the response is successful
