@PAWRA-142
@authorization
Feature: Location-scoped membership permissions

  Rule: Location permissions never cross organization tenant boundaries

    Scenario: Staff accesses data in an authorized location of their organization
      Given staff member Alice belongs to organization A
      And Alice has access to location A1
      When Alice requests protected data owned by location A1
      Then access is granted

    Scenario: Staff attempts to cross an organization boundary
      Given staff member Alice belongs to organization A
      And protected data belongs to organization B
      When Alice requests that protected data
      Then access is denied
