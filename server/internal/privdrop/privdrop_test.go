package privdrop

import "testing"

func TestTarget(t *testing.T) {
	cases := []struct {
		env      map[string]string
		uid, gid int
		ok, err  bool
	}{
		{env: map[string]string{}},
		{env: map[string]string{"PUID": "0"}},
		{env: map[string]string{"PUID": "65532", "PGID": "65532"}, uid: 65532, gid: 65532, ok: true},
		{env: map[string]string{"PUID": "1026"}, uid: 1026, gid: 1026, ok: true},
		{env: map[string]string{"PUID": "1026", "PGID": "100"}, uid: 1026, gid: 100, ok: true},
		{env: map[string]string{"PUID": "abc"}, err: true},
		{env: map[string]string{"PUID": "-1"}, err: true},
		{env: map[string]string{"PUID": "1000", "PGID": "x"}, err: true},
	}
	for _, c := range cases {
		uid, gid, ok, err := Target(func(k string) string { return c.env[k] })
		if (err != nil) != c.err || ok != c.ok || (ok && (uid != c.uid || gid != c.gid)) {
			t.Errorf("%v: got %d:%d ok=%v err=%v", c.env, uid, gid, ok, err)
		}
	}
}
