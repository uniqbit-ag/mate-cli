---
type: delta-spec
change: <change-name>
capability: <capability>
tags: [openspec/change, openspec/spec, openspec/delta]
scopes:
  - repository: org/repository
    area: .
---

## ADDED Requirements

### Requirement: <!-- capability or behavior -->

As a <!-- role -->, I want <!-- capability -->, so that <!-- benefit -->.
The system MUST support this behavior.
**Area:** `.` <!-- replace with the Area from scopes -->

<!-- Every requirement must bind an Area from the frontmatter scopes. -->

#### Acceptance Criteria

- **Given** <!-- context -->
- **When** <!-- condition -->
- **Then** <!-- expected outcome -->

## MODIFIED Requirements

### Requirement: <!-- existing capability or behavior -->

As a <!-- role -->, I want <!-- updated capability -->, so that <!-- updated benefit -->.
The system MUST support the updated behavior.
**Area:** `.` <!-- replace with the Area from scopes -->

#### Acceptance Criteria

- **Given** <!-- context -->
- **When** <!-- updated condition -->
- **Then** <!-- updated expected outcome -->

## REMOVED Requirements

### Requirement: <!-- removed capability or behavior -->

As a <!-- role -->, I wanted <!-- removed capability -->, so that <!-- previous benefit -->.
**Reason**: <!-- why this story is removed -->
**Migration**: <!-- how users move away from it -->
**Area:** `.` <!-- replace with the Area from scopes -->
