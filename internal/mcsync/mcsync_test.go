package mcsync

import (
	"context"
	"testing"
)

func TestNewRequiresFullConfiguration(t *testing.T) {
	// Every dependency missing in turn must yield nil rather than a Syncer that
	// panics on first use.
	if New(nil, nil, "role") != nil {
		t.Error("nil store should yield nil")
	}
	if New(nil, nil, "") != nil {
		t.Error("no config at all should yield nil")
	}
}

func TestNilSyncerIsInert(t *testing.T) {
	var s *Syncer
	changed, err := s.Apply(context.Background(), "g", "u", true)
	if err != nil || changed {
		t.Errorf("nil syncer Apply = (%v, %v), want (false, nil)", changed, err)
	}
	if s.HasRole([]string{"anything"}) {
		t.Error("nil syncer should never report holding a role")
	}
	if s.RoleID() != "" {
		t.Error("nil syncer RoleID should be empty")
	}
}

func TestHasRole(t *testing.T) {
	s := &Syncer{roleID: "123"}
	if !s.HasRole([]string{"456", "123"}) {
		t.Error("should match a role present in the list")
	}
	if s.HasRole([]string{"456", "789"}) {
		t.Error("should not match when absent")
	}
	if s.HasRole(nil) {
		t.Error("empty role list should not match")
	}
}
